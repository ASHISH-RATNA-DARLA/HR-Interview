// components/EmotionDetector.tsx
"use client";

import dynamic from "next/dynamic";
import React, { useEffect, useRef, forwardRef, useImperativeHandle } from "react";

/** Per-frame record */
type FrameRecord = {
  ts: number; // performance.now()

  // detections count
  faceCount: number;
  bodyCount: number;
  handCount: number;
  objectCount: number;

  // Face main
  faceScore?: number;
  bbox?: { x: number; y: number; w: number; h: number };

  // Head pose
  yaw?: number;   // radians
  pitch?: number; // radians
  roll?: number;  // radians

  // Mesh/Iris derived
  ear?: number;                // Eye Aspect Ratio
  blinkStarted?: boolean;      // true on the frame a blink begins
  eyeContact?: boolean;        // heuristic: gaze to camera
  leftIrisCenter?: { x: number; y: number } | null;   // normalized in eye box
  rightIrisCenter?: { x: number; y: number } | null;  // normalized in eye box
  pupilRatio?: number;         // proxy: iris radius / eye width

  // Liveness & anti-spoof
  livenessScore?: number;
  antispoofScore?: number;

  // Description (embedding not stored; size would explode)
  descriptionScore?: number;

  // Emotion
  emotionsRaw?: Record<string, number>;
  emotionsAvg5?: Record<string, number>;
  topEmotion?: string | null;

  // Body summary (posture hints)
  bodyScore?: number;
  postureHint?: "centered" | "lean-left" | "lean-right" | "far" | "close" | "ok";

  // Hands summary
  handActivity?: "none" | "one-hand" | "two-hands";

  // Objects found (labels only)
  objects?: Array<{ label: string; score: number }>;

  // timings
  inferMs?: number;
};

type Metrics = {
  // session
  startedAt: string;
  endedAt?: string;
  durationSec?: number;

  // performance
  frames: number;
  fpsEstimate: number;

  // compliance
  multiPersonWarnings: number;

  // focus
  eyeContactFrames: number;
  offscreenFrames: number;
  eyeContactPercent: number;
  offscreenSeconds: number;

  // blinks
  blinkCount: number;
  blinkRatePerMin: number;
  blinkTimestamps: number[]; // perf.now() of each blink

  // attention drift streaks (consecutive offscreen frames @30fps)
  longestOffscreenStreakFrames: number;
  currentOffscreenStreakFrames: number;

  // pupil proxy
  avgPupilRatio: number;

  // emotions aggregate
  emotionTopCounts: Record<string, number>;
  lastEmotionsAvg5: Record<string, number>;

  // model scores (last seen)
  lastLivenessScore?: number;
  lastAntispoofScore?: number;

  // hands/objects aggregates
  totalHandActiveFrames: number; // frames with at least one hand
  objectLabelCounts: Record<string, number>;

  // body posture tallies
  postureCounts: Record<NonNullable<FrameRecord["postureHint"]>, number>;

  // raw frames (can be large)
  framesLog: FrameRecord[];
};

export type EmotionDetectorHandle = {
  /** Compute final snapshot & save report to /api/save-metrics */
  finalizeAndSave: () => Promise<void>;
};

type EmotionDetectorProps = {
  /** Optional: host-provided webcam stream (prevents duplicate permission prompts) */
  externalStream?: MediaStream | null;
  /** Hide/show the internal <video> */
  showVideo?: boolean;
  /** size when showVideo=true */
  width?: number;
  height?: number;
  /** Save policy: "manual" = parent calls finalizeAndSave; "auto" (default) = save on unmount */
  saveMode?: "auto" | "manual";
  /** Pause inference (used during 3s penalty freeze) */
  paused?: boolean;
  /** Callback for policy events (e.g., multi-person) */
  onPolicyEvent?: (e: { type: "multi-person-detected" }) => void;
};

const EmotionDetectorImpl = forwardRef<EmotionDetectorHandle, EmotionDetectorProps>(function EmotionDetectorImpl(
  {
    externalStream = null,
    showVideo = false,
    width = 640,
    height = 480,
    saveMode = "auto",
    paused = false,
    onPolicyEvent,
  },
  ref
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const humanRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef<boolean>(false);
  const startedRef = useRef<boolean>(false); // guard Strict Mode double-run
  const streamRef = useRef<MediaStream | null>(null);
  const ownsStreamRef = useRef<boolean>(false); // stop only if we created it

  // emotion smoothing
  const emotionHistoryRef = useRef<Map<string, number[]>>(new Map());

  // warn cooldown for multi-person
  const lastWarnAtRef = useRef<number>(0);
  const WARN_COOLDOWN_MS = 5000;

  // first-frame guard (avoid empty saves)
  const sawFirstFrameRef = useRef<boolean>(false);

  // session metrics
  const metricsRef = useRef<Metrics>({
    startedAt: new Date().toISOString(),
    frames: 0,
    fpsEstimate: 0,
    multiPersonWarnings: 0,

    eyeContactFrames: 0,
    offscreenFrames: 0,
    eyeContactPercent: 0,
    offscreenSeconds: 0,

    blinkCount: 0,
    blinkRatePerMin: 0,
    blinkTimestamps: [],

    longestOffscreenStreakFrames: 0,
    currentOffscreenStreakFrames: 0,

    avgPupilRatio: 0,
    emotionTopCounts: {},
    lastEmotionsAvg5: {},

    totalHandActiveFrames: 0,
    objectLabelCounts: {},
    postureCounts: { centered: 0, "lean-left": 0, "lean-right": 0, far: 0, close: 0, ok: 0 },

    framesLog: [],
  });

  // timing helpers
  const tickAccumRef = useRef<number>(0);
  const frameCountWindowRef = useRef<number>(0);
  const lastFrameTsRef = useRef<number>(performance.now());

  // blink state (EAR)
  const blinkStateRef = useRef<{ inBlink: boolean; earBelowCount: number }>({
    inBlink: false,
    earBelowCount: 0,
  });

  // autosave checkpoint timer (disabled per requirement)
  const checkpointTimerRef = useRef<number | null>(null);

  // constants
  const BASE_LOOP_MS = 33; // ~30 FPS
  const EAR_THRESHOLD = 0.21;
  const EAR_CONSEC_FRAMES = 2;
  const GAZE_YAW_MAX = 60 * (Math.PI / 180); // Extremely lenient
  const GAZE_PITCH_MAX = 55 * (Math.PI / 180); // Extremely lenient
  const IRIS_CENTER_TOL = 0.95; // Extremely lenient

  // Expose finalizeAndSave() to parent (for manual save at successful end only)
  useImperativeHandle(ref, () => ({
    async finalizeAndSave() {
      const now = new Date();
      const m = metricsRef.current;
      m.endedAt = now.toISOString();
      m.durationSec = Math.max(0, Math.round((now.getTime() - new Date(m.startedAt).getTime()) / 1000));

      const totalFrames = Math.max(1, m.eyeContactFrames + m.offscreenFrames);
      m.eyeContactPercent = +(100 * (m.eyeContactFrames / totalFrames)).toFixed(2);
      m.offscreenSeconds = +(m.offscreenFrames / 30).toFixed(2);
      m.blinkRatePerMin = m.durationSec > 0 ? +(60 * (m.blinkCount / m.durationSec)).toFixed(2) : 0;
      m.avgPupilRatio = +m.avgPupilRatio.toFixed(4);
      m.fpsEstimate = +m.fpsEstimate.toFixed(2);

      if (!sawFirstFrameRef.current || m.frames <= 0) return; // nothing collected
      await saveMetrics(m).catch(() => {});
    },
  }));

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let mounted = true;

    async function start() {
      const { default: Human } = await import("@vladmandic/human");

      // IMPORTANT: model files must exist under /public/models with these names:
      // blazeface.json/bin, facemesh.json/bin, iris.json/bin, emotion.json/bin,
      // faceres.json/bin, antispoof.json/bin, liveness.json/bin,
      // movenet-lightning.json/bin, handtrack.json/bin, handlandmark-lite.json/bin,
      // centernet.json/bin
      const humanConfig = {
        backend: "webgl",
        modelBasePath: "/models",
        cacheSensitivity: 0,
        filter: { enabled: true },
        debug: false,

        face: {
          enabled: true,
          detector: {
            enabled: true,
            modelPath: "blazeface.json", // use blazeface.json+bin
            maxDetected: 3,
            skipFrames: 0,
            minConfidence: 0.05, // Further lowered for maximum leniency in face detection
          },
          mesh: { enabled: true, modelPath: "facemesh.json" },
          iris: { enabled: true, modelPath: "iris.json" },
          attention: { enabled: false },
          emotion: { enabled: true, modelPath: "emotion.json", minConfidence: 0.1, skipFrames: 0 },
          description: { enabled: true, modelPath: "faceres.json", minConfidence: 0.2, skipFrames: 15 },
          antispoof: { enabled: true, modelPath: "antispoof.json", skipFrames: 30 },
          liveness: { enabled: true, modelPath: "liveness.json", skipFrames: 30 },
        },

        body: {
          enabled: true,
          modelPath: "movenet-lightning.json",
          maxDetected: 3,
          skipFrames: 1,
          minConfidence: 0.3,
        },

        hand: {
          enabled: true,
          rotation: false,
          landmarks: true,
          minConfidence: 0.5,
          iouThreshold: 0.2,
          maxDetected: 2,
          skipFrames: 1,
          detector: { modelPath: "handtrack.json" },
          skeleton: { modelPath: "handlandmark-lite.json" },
        },

        object: {
          enabled: true,
          modelPath: "centernet.json",
          minConfidence: 0.3,
          iouThreshold: 0.4,
          maxDetected: 5,
          skipFrames: 20,
        },

        gesture: { enabled: true },
        segmentation: { enabled: false },
      } as const;

      const human = new Human(humanConfig);
      humanRef.current = human;

      // Use WebGL explicitly; remove webgpu to silence adapter logs
      try {
        if (typeof human.tf.findBackend === "function" && human.tf.findBackend("webgpu")) {
          await human.tf.removeBackend?.("webgpu");
        }
      } catch {}
      await human.tf.setBackend("webgl");
      await human.tf.ready();

      await human.load();
      await human.warmup();

      // Webcam: use host-provided stream if available
      let stream: MediaStream | null = null;
      if (externalStream) {
        stream = externalStream;
        ownsStreamRef.current = false;
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 }, facingMode: "user" },
          audio: false,
        });
        ownsStreamRef.current = true;
      }
      if (!mounted || !stream) return;
      streamRef.current = stream;

      const video = videoRef.current!;
      video.srcObject = stream;

      await new Promise<void>((res) => {
        if (video.readyState >= 1) return res();
        video.onloadedmetadata = () => res();
      });

      // wait until actually playing
      await new Promise<void>((res) => {
        if (!video.paused && !video.ended) return res();
        const onPlaying = () => {
          video.removeEventListener("playing", onPlaying);
          res();
        };
        video.addEventListener("playing", onPlaying);
        video.play().catch(() => {});
      });

      runningRef.current = true;
      lastFrameTsRef.current = performance.now();

      // Per requirement: no periodic checkpoints
      if (checkpointTimerRef.current) {
        clearInterval(checkpointTimerRef.current as unknown as number);
        checkpointTimerRef.current = null;
      }

      loop();
    }

    const loop = async () => {
      if (!runningRef.current || !videoRef.current || !humanRef.current) return;

      // Pause support for 3s penalty window
      if (paused) {
        rafRef.current = window.setTimeout(() => requestAnimationFrame(loop), 120) as unknown as number;
        return;
      }

      const t0 = performance.now();
      const human = humanRef.current;
      const result = await human.detect(videoRef.current);
      const t1 = performance.now();

      // fps estimate
      const dt = t1 - lastFrameTsRef.current;
      lastFrameTsRef.current = t1;
      tickAccumRef.current += dt;
      frameCountWindowRef.current += 1;
      if (tickAccumRef.current >= 1000) {
        metricsRef.current.fpsEstimate = frameCountWindowRef.current / (tickAccumRef.current / 1000);
        tickAccumRef.current = 0;
        frameCountWindowRef.current = 0;
      }

      // counts
      const faceCount = result?.face?.length ?? 0;
      const bodyCount = result?.body?.length ?? 0;
      const handCount = result?.hand?.length ?? 0;
      const objectCount = result?.object?.length ?? 0;

      // one-person rule -> callback (no alert)
      if (faceCount > 1 || bodyCount > 1) {
        const now = performance.now();
        if (now - lastWarnAtRef.current > WARN_COOLDOWN_MS) {
          lastWarnAtRef.current = now;
          metricsRef.current.multiPersonWarnings += 1;
          onPolicyEvent?.({ type: "multi-person-detected" });
        }
      }

      // choose primary face
      const face0 = result?.face?.[0];
      let yaw: number | undefined,
        pitch: number | undefined,
        roll: number | undefined,
        ear: number | undefined,
        blinkStarted = false,
        eyeContact = false,
        leftIrisCenter: { x: number; y: number } | null = null,
        rightIrisCenter: { x: number; y: number } | null = null,
        pupilRatio: number | undefined,
        faceScore: number | undefined,
        bbox:
          | { x: number; y: number; w: number; h: number }
          | undefined,
        livenessScore: number | undefined,
        antispoofScore: number | undefined,
        descriptionScore: number | undefined;

      // emotions
      const emotionsRaw: Record<string, number> = {};
      if (face0) {
        faceScore = face0.score;
        if (face0.box) {
          const b = face0.box; // {startPoint, endPoint}
          bbox = { x: b[0][0], y: b[0][1], w: b[1][0] - b[0][0], h: b[1][1] - b[0][1] };
        }

        yaw = face0.rotation?.angle?.yaw ?? 0;
        pitch = face0.rotation?.angle?.pitch ?? 0;
        roll = face0.rotation?.angle?.roll ?? 0;

        // liveness / antispoof / description (if present)
        livenessScore = face0.liveness?.score ?? undefined;
        antispoofScore = face0.antispoof?.score ?? undefined;
        descriptionScore = face0.description?.score ?? undefined;
        if (livenessScore !== undefined) metricsRef.current.lastLivenessScore = livenessScore;
        if (antispoofScore !== undefined) metricsRef.current.lastAntispoofScore = antispoofScore;

        // emotions
        for (const e of face0.emotion ?? []) emotionsRaw[e.emotion] = e.score;

        // blink + iris
        const mesh = face0.mesh ?? [];
        const iris = face0.iris ?? [];

        // EAR for blink
        if (mesh.length >= 468) {
          const L = { p1: 33, p2: 160, p3: 158, p4: 133, p5: 153, p6: 144 };
          const R = { p1: 263, p2: 387, p3: 385, p4: 362, p5: 380, p6: 373 };
          const earLeft = earFrom6(mesh, L);
          const earRight = earFrom6(mesh, R);
          ear = (earLeft + earRight) / 2;

          const st = blinkStateRef.current;
          if (ear < EAR_THRESHOLD) {
            st.earBelowCount += 1;
            if (!st.inBlink && st.earBelowCount >= EAR_CONSEC_FRAMES) {
              st.inBlink = true;
              metricsRef.current.blinkCount += 1;
              metricsRef.current.blinkTimestamps.push(t1);
              blinkStarted = true;
            }
          } else {
            st.earBelowCount = 0;
            st.inBlink = false;
          }
        }

        // Iris centers & eye contact & pupil ratio proxy
        if (mesh.length >= 468 && iris.length >= 10) {
          const leftIris = iris.slice(0, 5);
          const rightIris = iris.slice(5, 10);
          const leftBox = eyeBounds(mesh, "left");
          const rightBox = eyeBounds(mesh, "right");
          const leftC = centroid(leftIris);
          const rightC = centroid(rightIris);
          const leftNorm = normalizePointInBox(leftC, leftBox);
          const rightNorm = normalizePointInBox(rightC, rightBox);
          leftIrisCenter = leftNorm;
          rightIrisCenter = rightNorm;

          const centerish =
            Math.abs(leftNorm.x - 0.5) <= IRIS_CENTER_TOL &&
            Math.abs(leftNorm.y - 0.5) <= IRIS_CENTER_TOL &&
            Math.abs(rightNorm.x - 0.5) <= IRIS_CENTER_TOL &&
            Math.abs(rightNorm.y - 0.5) <= IRIS_CENTER_TOL;

          const headFacing = Math.abs(yaw ?? 0) <= GAZE_YAW_MAX && Math.abs(pitch ?? 0) <= GAZE_PITCH_MAX;
          eyeContact = centerish && headFacing;

          if (eyeContact) {
            metricsRef.current.eyeContactFrames += 1;
            metricsRef.current.currentOffscreenStreakFrames = 0;
          } else {
            metricsRef.current.offscreenFrames += 1;
            metricsRef.current.currentOffscreenStreakFrames += 1;
            metricsRef.current.longestOffscreenStreakFrames = Math.max(
              metricsRef.current.longestOffscreenStreakFrames,
              metricsRef.current.currentOffscreenStreakFrames
            );
          }

          const leftR = avgRadius(leftIris);
          const rightR = avgRadius(rightIris);
          pupilRatio = 0.5 * (leftR / (leftBox.w || 1) + rightR / (rightBox.w || 1));
          const m = metricsRef.current;
          m.avgPupilRatio = m.avgPupilRatio === 0 ? pupilRatio : m.avgPupilRatio * 0.99 + pupilRatio * 0.01;
        }
      }

      // emotions smoothing (avg of last 5 per label)
      for (const [k, v] of Object.entries(emotionsRaw)) {
        if (!emotionHistoryRef.current.has(k)) emotionHistoryRef.current.set(k, []);
        const arr = emotionHistoryRef.current.get(k)!;
        arr.push(v);
        if (arr.length > 5) arr.shift();
      }
      const emotionsAvg5: Record<string, number> = {};
      for (const [k, arr] of emotionHistoryRef.current.entries()) {
        if (arr.length) emotionsAvg5[k] = arr.reduce((a, b) => a + b, 0) / arr.length;
      }
      let topEmotion: string | null = null;
      const avgEntries = Object.entries(emotionsAvg5);
      if (avgEntries.length) {
        avgEntries.sort((a, b) => b[1] - a[1]);
        topEmotion = avgEntries[0][0];
        metricsRef.current.emotionTopCounts[topEmotion] =
          (metricsRef.current.emotionTopCounts[topEmotion] || 0) + 1;
      }
      metricsRef.current.lastEmotionsAvg5 = emotionsAvg5;

      // Body posture hint (very light heuristic)
      let bodyScore: number | undefined;
      let postureHint: FrameRecord["postureHint"] = "ok";
      const body0 = result.body?.[0];
      if (body0) {
        bodyScore = body0.score;
        const kp = body0.keypoints || [];
        const nose = kp.find((k: any) => /nose/i.test(k.part || k.name));
        const lShoulder = kp.find((k: any) => /(left_shoulder|leftShoulder)/i.test(k.part || k.name));
        const rShoulder = kp.find((k: any) => /(right_shoulder|rightShoulder)/i.test(k.part || k.name));
        if (lShoulder && rShoulder) {
          const dx = (lShoulder.x ?? lShoulder.position?.x) - (rShoulder.x ?? rShoulder.position?.x);
          if (dx > 40) postureHint = "lean-left";
          else if (dx < -40) postureHint = "lean-right";
        }
        if (nose && face0?.box) {
          const faceW = (face0.box[1][0] - face0.box[0][0]) || 1;
          if (faceW < 30) postureHint = "far"; // Very lenient "far" detection
          else if (faceW > 350) postureHint = "close"; // Very lenient "close" detection
          else if (postureHint === "ok") postureHint = "centered";
        }
        metricsRef.current.postureCounts[postureHint] += 1;
      }

      // Hand activity
      let handActivity: FrameRecord["handActivity"] = "none";
      if (handCount >= 2) handActivity = "two-hands";
      else if (handCount === 1) handActivity = "one-hand";
      if (handCount > 0) metricsRef.current.totalHandActiveFrames += 1;

      // Objects
      const objects =
        result.object?.map((o: any) => ({ label: o.label, score: o.score })) ?? [];
      for (const o of objects) {
        metricsRef.current.objectLabelCounts[o.label] =
          (metricsRef.current.objectLabelCounts[o.label] || 0) + 1;
      }

      // Build frame record
      metricsRef.current.frames += 1;
      sawFirstFrameRef.current = true;

      const frame: FrameRecord = {
        ts: t0,
        faceCount,
        bodyCount,
        handCount,
        objectCount,

        faceScore,
        bbox,

        yaw,
        pitch,
        roll,

        ear,
        blinkStarted: blinkStarted ? true : undefined,
        eyeContact,
        leftIrisCenter,
        rightIrisCenter,
        pupilRatio,

        livenessScore,
        antispoofScore,
        descriptionScore,

        emotionsRaw: Object.keys(emotionsRaw).length ? emotionsRaw : undefined,
        emotionsAvg5: Object.keys(emotionsAvg5).length ? emotionsAvg5 : undefined,
        topEmotion,

        bodyScore,
        postureHint,

        handActivity,

        objects: objects.length ? objects : undefined,

        inferMs: performance.now() - t0,
      };
      metricsRef.current.framesLog.push(frame);

      // next frame ~30fps
      const inferElapsed = performance.now() - t0;
      const delay = Math.max(0, BASE_LOOP_MS - inferElapsed);
      rafRef.current = window.setTimeout(() => requestAnimationFrame(loop), delay) as unknown as number;
    };

    start().catch((err) => console.error("[EmotionDetector] init error:", err));

    return () => {
      runningRef.current = false;

      // finalize (compute, but saving policy below)
      const now = new Date();
      const m = metricsRef.current;
      m.endedAt = now.toISOString();
      m.durationSec = Math.max(0, Math.round((now.getTime() - new Date(m.startedAt).getTime()) / 1000));

      const totalFrames = Math.max(1, m.eyeContactFrames + m.offscreenFrames);
      m.eyeContactPercent = +(100 * (m.eyeContactFrames / totalFrames)).toFixed(2);
      m.offscreenSeconds = +(m.offscreenFrames / 30).toFixed(2);
      m.blinkRatePerMin = m.durationSec > 0 ? +(60 * (m.blinkCount / m.durationSec)).toFixed(2) : 0;
      m.avgPupilRatio = +m.avgPupilRatio.toFixed(4);
      m.fpsEstimate = +m.fpsEstimate.toFixed(2);

      // clear timers
      if (rafRef.current !== null) {
        try {
          cancelAnimationFrame(rafRef.current);
          clearTimeout(rafRef.current as unknown as number);
        } catch {}
      }
      if (checkpointTimerRef.current) {
        clearInterval(checkpointTimerRef.current as unknown as number);
        checkpointTimerRef.current = null;
      }

      // SAVE policy
      if (saveMode === "auto") {
        if (sawFirstFrameRef.current && m.frames > 0) {
          void saveMetrics(m).catch(() => {});
        } else {
          console.warn("[Interview] skipped save: no frames processed.");
        }
      }

      // Only stop tracks if we created the stream
      if (ownsStreamRef.current && streamRef.current) {
        for (const t of streamRef.current.getTracks()) t.stop();
      }
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalStream, paused, saveMode, onPolicyEvent]);

  // hide video when not needed
  return (
    <video
      ref={videoRef}
      style={{
        width: showVideo ? `${width}px` : "1px",
        height: showVideo ? `${height}px` : "1px",
        opacity: showVideo ? 1 : 0,
        pointerEvents: "none",
        position: showVideo ? "relative" as const : "absolute" as const,
        left: 0,
        top: 0,
      }}
      width={width}
      height={height}
      playsInline
      muted
      autoPlay
    />
  );
});

function dist(a: number[], b: number[]) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.hypot(dx, dy);
}
function earFrom6(
  mesh: any[],
  idx: { p1: number; p2: number; p3: number; p4: number; p5: number; p6: number }
) {
  const P1 = mesh[idx.p1],
    P2 = mesh[idx.p2],
    P3 = mesh[idx.p3],
    P4 = mesh[idx.p4],
    P5 = mesh[idx.p5],
    P6 = mesh[idx.p6];
  const A = dist(P2, P6);
  const B = dist(P3, P5);
  const C = dist(P1, P4);
  return (A + B) / (2.0 * C);
}
function centroid(pts: number[][]) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  const n = Math.max(1, pts.length);
  return { x: x / n, y: y / n };
}
function eyeBounds(mesh: any[], which: "left" | "right") {
  const indices =
    which === "left"
      ? [33, 133, 160, 158, 153, 144]
      : [263, 362, 387, 385, 380, 373];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of indices) {
    const p = mesh[i];
    if (!p) continue;
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  return { x: minX, y: minY, w: Math.max(1e-6, maxX - minX), h: Math.max(1e-6, maxY - minY) };
}
function normalizePointInBox(
  pt: { x: number; y: number },
  box: { x: number; y: number; w: number; h: number }
) {
  return { x: (pt.x - box.x) / box.w, y: (pt.y - box.y) / box.h };
}
function avgRadius(pts: number[][]) {
  const c = centroid(pts);
  const rs = pts.map((p) => Math.hypot(p[0] - c.x, p[1] - c.y));
  return rs.reduce((a, b) => a + b, 0) / Math.max(1, rs.length);
}

/* --------------- persistence ----------------- */

// Saves to /api/save-metrics (server writes file under ./reports)
// If server write fails (prod or no FS), it triggers a browser download fallback.
async function saveMetrics(m: Metrics, opts?: { checkpoint?: boolean }) {
  try {
    const res = await fetch("/api/save-metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...m, _checkpoint: !!opts?.checkpoint }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText} :: ${text}`);
    }

    if (!opts?.checkpoint) console.log("[Interview] metrics saved to server file.");
  } catch (err) {
    console.warn("[Interview] server save failed, downloading locally instead:", err);
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const blob = new Blob([JSON.stringify(m, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `session-metrics-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      console.log("[Interview] metrics downloaded as JSON.");
    } catch (e) {
      console.error("[Interview] failed to download metrics:", e);
    }
  }
}

const EmotionDetector = dynamic(async () => Promise.resolve(EmotionDetectorImpl), { ssr: false });
export default EmotionDetector;
