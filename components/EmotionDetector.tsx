"use client";

import dynamic from "next/dynamic";
import React, { useEffect, useRef, forwardRef, useImperativeHandle } from "react";

/** Per-frame record */
type FrameRecord = {
  ts: number; // performance.now()
  faceCount: number;
  bodyCount: number;
  handCount: number;
  objectCount: number;

  // Head movements
  nodCount?: number;
  shakeCount?: number;

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
  leftIrisCenter?: { x: number; y: number } | null;
  rightIrisCenter?: { x: number; y: number } | null;
  pupilRatio?: number;         // proxy: iris radius / eye width

  // Liveness & anti-spoof
  livenessScore?: number;
  antispoofScore?: number;

  // Description
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
  startedAt: string;
  endedAt?: string;
  durationSec?: number;

  frames: number;
  fpsEstimate: number;

  multiPersonWarnings: number;

  eyeContactFrames: number;
  offscreenFrames: number;
  eyeContactPercent: number;
  offscreenSeconds: number;

  blinkCount: number;
  blinkRatePerMin: number;
  blinkTimestamps: number[];

  longestOffscreenStreakFrames: number;
  currentOffscreenStreakFrames: number;

  avgPupilRatio: number;

  emotionTopCounts: Record<string, number>;
  lastEmotionsAvg5: Record<string, number>;

  totalHandActiveFrames: number;
  objectLabelCounts: Record<string, number>;

  postureCounts: Record<NonNullable<FrameRecord["postureHint"]>, number>;

  nodCount: number;
  shakeCount: number;

  framesLog: FrameRecord[];
};

export type EmotionDetectorHandle = {
  finalizeAndSave: () => Promise<void>;
};

type EmotionDetectorProps = {
  externalStream?: MediaStream | null;
  showVideo?: boolean;
  width?: number;
  height?: number;
  saveMode?: "auto" | "manual";
  paused?: boolean;
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
  const startedRef = useRef<boolean>(false);
  const streamRef = useRef<MediaStream | null>(null);
  const ownsStreamRef = useRef<boolean>(false);

  const emotionHistoryRef = useRef<Map<string, number[]>>(new Map());
  const lastWarnAtRef = useRef<number>(0);
  const WARN_COOLDOWN_MS = 5000;
  const sawFirstFrameRef = useRef<boolean>(false);

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

    nodCount: 0,
    shakeCount: 0,

    framesLog: [],
  });

  const tickAccumRef = useRef<number>(0);
  const frameCountWindowRef = useRef<number>(0);
  const lastFrameTsRef = useRef<number>(performance.now());

  const blinkStateRef = useRef<{ inBlink: boolean; earBelowCount: number }>({
    inBlink: false,
    earBelowCount: 0,
  });

  const headMovementStateRef = useRef<{
    lastYaw: number | null;
    lastPitch: number | null;
    noddingStreak: number;
    shakingStreak: number;
  }>({
    lastYaw: null,
    lastPitch: null,
    noddingStreak: 0,
    shakingStreak: 0,
  });

  const checkpointTimerRef = useRef<number | null>(null);

  const BASE_LOOP_MS = 33;
  const EAR_THRESHOLD = 0.21;
  const EAR_CONSEC_FRAMES = 2;
  const GAZE_YAW_MAX = 60 * (Math.PI / 180);
  const GAZE_PITCH_MAX = 55 * (Math.PI / 180);
  const IRIS_CENTER_TOL = 0.95;

  // Head movement thresholds (radians)
  const NOD_PITCH_THRESHOLD = 0.1; // ~5.7 degrees
  const SHAKE_YAW_THRESHOLD = 0.1; // ~5.7 degrees
  const MOVEMENT_CONSEC_FRAMES = 2;

  const waitForVideoRef = async (timeoutMs = 1000) => {
    const start = performance.now();
    while (!videoRef.current && performance.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return videoRef.current;
  };

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

      if (!sawFirstFrameRef.current || m.frames <= 0) return;
      await saveMetrics(m).catch(() => {});
    },
  }));

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let mounted = true;

    async function start() {
      const { default: Human } = await import("@vladmandic/human");

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
            modelPath: "blazeface.json",
            maxDetected: 3,
            skipFrames: 0,
            minConfidence: 0.05,
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

      try {
        if (typeof human.tf.findBackend === "function" && human.tf.findBackend("webgpu")) {
          await human.tf.removeBackend?.("webgpu");
        }
      } catch {}
      await human.tf.setBackend("webgl");
      await human.tf.ready();

      await human.load();
      await human.warmup();

      // Webcam
      let stream: MediaStream | null = null;
      if (externalStream) {
        stream = externalStream;
        ownsStreamRef.current = false;
      } else {
        const tryGet = async (w: number, h: number) => {
          try {
            return await navigator.mediaDevices.getUserMedia({
              video: {
                width: { ideal: w, min: 640 },
                height: { ideal: h, min: 480 },
                frameRate: { ideal: 30, max: 60 },
                facingMode: "user",
              },
              audio: false,
            });
          } catch {
            return null;
          }
        };

        const order: Array<[number, number]> = [
          [1280, 720],
          [960, 540],
          [640, 480],
        ];

        for (const [w, h] of order) {
          stream = await tryGet(w, h);
          if (stream) break;
        }
        if (!stream) throw new Error("Failed to acquire webcam stream");

        ownsStreamRef.current = true;

        const vtrack = stream.getVideoTracks?.()[0];
        const s = vtrack?.getSettings?.();
        if (s?.width && s?.height) {
          const msg = `[Detector Camera] Using ${s.width}×${s.height} @ ${s.frameRate ?? "?"}fps`;
          console.log(msg);
          if ((s.height as number) < 600) {
            console.warn("[Detector Camera] Height < 600px — iris landmarks may be unreliable; HD recommended.");
          }
        }
      }

      if (!mounted || !stream) return;
      streamRef.current = stream;

      // Wait for <video> ref
      const video = (await waitForVideoRef(800)) || null;
      if (!mounted || !video) {
        console.warn("[EmotionDetector] video element not ready; skipping srcObject bind");
        return;
      }

      // Bind safely
      try {
        (video as any).srcObject = stream;
      } catch {
        (video as HTMLVideoElement).srcObject = stream as any;
      }

      await new Promise<void>((res) => {
        if (video.readyState >= 1) return res();
        video.onloadedmetadata = () => res();
      });

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

      if (checkpointTimerRef.current) {
        clearInterval(checkpointTimerRef.current as unknown as number);
        checkpointTimerRef.current = null;
      }

      loop();
    }

    const loop = async () => {
      if (!runningRef.current || !videoRef.current || !humanRef.current) return;

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

      // Hoist frequently used references ONCE per frame
      const faces = result?.face ?? [];
      const bodies = result?.body ?? [];
      const hands = result?.hand ?? [];
      const objects = result?.object ?? [];

      const face0 = faces[0];
      const body0 = bodies[0];

      const faceCount = faces.length;
      const bodyCount = bodies.length;
      const handCount = hands.length;
      const objectCount = objects.length;

      if (faceCount > 1 || bodyCount > 1) {
        const now = performance.now();
        if (now - lastWarnAtRef.current > WARN_COOLDOWN_MS) {
          lastWarnAtRef.current = now;
          metricsRef.current.multiPersonWarnings += 1;
          onPolicyEvent?.({ type: "multi-person-detected" });
        }
      }

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
        descriptionScore: number | undefined,
        nodCount: number | undefined,
        shakeCount: number | undefined;

      const emotionsRaw: Record<string, number> = {};
      if (face0) {
        faceScore = face0.score;
        if (face0.box) {
          const b = face0.box;
          bbox = { x: b[0][0], y: b[0][1], w: b[1][0] - b[0][0], h: b[1][1] - b[0][1] };
        }

        yaw = face0.rotation?.angle?.yaw ?? 0;
        pitch = face0.rotation?.angle?.pitch ?? 0;
        roll = face0.rotation?.angle?.roll ?? 0;

        livenessScore = face0.liveness?.score ?? undefined;
        antispoofScore = face0.antispoof?.score ?? undefined;
        descriptionScore = face0.description?.score ?? undefined;
        // Removed metricsRef.current.lastLivenessScore and lastAntispoofScore as they are not in Metrics type yet

        for (const e of face0.emotion ?? []) emotionsRaw[e.emotion] = e.score;

        const mesh = face0.mesh ?? [];
        const iris = face0.iris ?? [];

        if (mesh.length >= 468) {
          // EAR / blink
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

        // Head movement detection (nodding/shaking)
        const hmState = headMovementStateRef.current;
        if (typeof yaw === "number" && typeof pitch === "number") {
          if (hmState.lastPitch !== null) {
            const pitchDiff = pitch - hmState.lastPitch;
            if (Math.abs(pitchDiff) > NOD_PITCH_THRESHOLD) {
              hmState.noddingStreak += 1;
              if (hmState.noddingStreak >= MOVEMENT_CONSEC_FRAMES) {
                metricsRef.current.nodCount += 1;
                nodCount = metricsRef.current.nodCount; // Update for current frame record
                hmState.noddingStreak = 0; // Reset after detection
              }
            } else {
              hmState.noddingStreak = 0;
            }
          }
          if (hmState.lastYaw !== null) {
            const yawDiff = yaw - hmState.lastYaw;
            if (Math.abs(yawDiff) > SHAKE_YAW_THRESHOLD) {
              hmState.shakingStreak += 1;
              if (hmState.shakingStreak >= MOVEMENT_CONSEC_FRAMES) {
                metricsRef.current.shakeCount += 1;
                shakeCount = metricsRef.current.shakeCount; // Update for current frame record
                hmState.shakingStreak = 0; // Reset after detection
              }
            } else {
              hmState.shakingStreak = 0;
            }
          }
          hmState.lastPitch = pitch;
          hmState.lastYaw = yaw;
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

          if (videoRef.current) {
            const leftR = avgRadius(leftIris);
            const rightR = avgRadius(rightIris);
            pupilRatio = 0.5 * (leftR / (leftBox.w || 1) + rightR / (rightBox.w || 1));
            const m = metricsRef.current;
            m.avgPupilRatio = m.avgPupilRatio === 0 ? pupilRatio : m.avgPupilRatio * 0.99 + pupilRatio * 0.01;
          }
        } else {
          // Fallback eye-contact from head pose when iris is unavailable
          if (typeof yaw === "number" && typeof pitch === "number") {
            const YAW_MAX = 20 * (Math.PI / 180);
            const PITCH_MAX = 15 * (Math.PI / 180);
            eyeContact = Math.abs(yaw) <= YAW_MAX && Math.abs(pitch) <= PITCH_MAX;
          }
        }

        // Update engagement counters
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

      // Body posture (ratio-based far/close)
      let postureHint: FrameRecord["postureHint"] = "ok";
      if (body0) {
        const kp = body0.keypoints || [];
        const lShoulder = kp.find((k: any) => /(left_shoulder|leftShoulder)/i.test(k.part || k.name));
        const rShoulder = kp.find((k: any) => /(right_shoulder|rightShoulder)/i.test(k.part || k.name));
        if (lShoulder && rShoulder) {
          const dx = (lShoulder.x ?? lShoulder.position?.x) - (rShoulder.x ?? rShoulder.position?.x);
          if (dx > 40) postureHint = "lean-left";
          else if (dx < -40) postureHint = "lean-right";
        }
      }
      if (face0?.box && videoRef.current) {
        const vw = Math.max(1, videoRef.current.videoWidth);
        const faceWpx = face0.box[1][0] - face0.box[0][0];
        const faceWratio = faceWpx / vw;
        if (faceWratio < 0.12) postureHint = "far";
        else if (faceWratio > 0.45) postureHint = "close";
        else if (postureHint === "ok") postureHint = "centered";
      }
      metricsRef.current.postureCounts[postureHint] += 1;

      // Hand activity
      let handActivity: FrameRecord["handActivity"] = "none";
      if (handCount >= 2) handActivity = "two-hands";
      else if (handCount === 1) handActivity = "one-hand";
      if (handCount > 0) metricsRef.current.totalHandActiveFrames += 1;

      // Objects & label counts
      const objectsMapped = objects.map((o: any) => ({ label: o.label, score: o.score }));
      for (const o of objectsMapped) {
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

        faceScore: face0?.score,
        bbox: face0?.box
          ? { x: face0.box[0][0], y: face0.box[0][1], w: face0.box[1][0] - face0.box[0][0], h: face0.box[1][1] - face0.box[0][1] }
          : undefined,

        yaw: face0?.rotation?.angle?.yaw ?? 0,
        pitch: face0?.rotation?.angle?.pitch ?? 0,
        roll: face0?.rotation?.angle?.roll ?? 0,

        ear,
        blinkStarted: blinkStarted ? true : undefined,
        eyeContact,
        leftIrisCenter,
        rightIrisCenter,
        pupilRatio,

        livenessScore: face0?.liveness?.score ?? undefined,
        antispoofScore: face0?.antispoof?.score ?? undefined,
        descriptionScore: face0?.description?.score ?? undefined,

        nodCount,
        shakeCount,

        emotionsRaw: Object.keys(emotionsRaw).length ? emotionsRaw : undefined,
        emotionsAvg5: Object.keys(metricsRef.current.lastEmotionsAvg5).length ? metricsRef.current.lastEmotionsAvg5 : undefined,
        topEmotion,

        bodyScore: body0?.score,
        postureHint,

        handActivity,

        objects: objectsMapped.length ? objectsMapped : undefined,

        inferMs: performance.now() - t0,
      };
      metricsRef.current.framesLog.push(frame);

      const inferElapsed = performance.now() - t0;
      const delay = Math.max(0, BASE_LOOP_MS - inferElapsed);
      rafRef.current = window.setTimeout(() => requestAnimationFrame(loop), delay) as unknown as number;
    };

    start().catch((err) => console.error("[EmotionDetector] init error:", err));

    return () => {
      runningRef.current = false;

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

      if (saveMode === "auto") {
        if (sawFirstFrameRef.current && m.frames > 0) {
          void saveMetrics(m).catch(() => {});
        } else {
          console.warn("[Interview] skipped save: no frames processed.");
        }
      }

      if (ownsStreamRef.current && streamRef.current) {
        for (const t of streamRef.current.getTracks()) t.stop();
      }
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalStream, paused, saveMode, onPolicyEvent]);

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
