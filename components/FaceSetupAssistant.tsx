// components/FaceSetupAssistant.tsx
"use client";

import React, { useEffect, useRef, useState } from "react";

type Tuning = {
  faceMinRatio?: number;
  faceMaxRatio?: number;
  centerTolX?: number;
  centerTolY?: number;
  detectFps?: number;
};

type Props = {
  stream: MediaStream;
  onConfirm: () => void;
  onStatus?: (ok: boolean) => void;
  compact?: boolean;
  tuning?: Tuning;
  showConfirmButton?: boolean;
};

type BrightnessLevel = "Too dark" | "Dim" | "Good" | "Harsh";

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}
function valid(n: any) {
  return typeof n === "number" && Number.isFinite(n);
}

export default function FaceSetupAssistant({
  stream,
  onConfirm,
  onStatus,
  compact = false,
  tuning,
  showConfirmButton = true,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const samplerCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [brightness, setBrightness] = useState<number>(0);
  const [level, setLevel] = useState<BrightnessLevel>("Too dark");
  const [resText, setResText] = useState<string>("—");

  const [faceBox, setFaceBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [aligned, setAligned] = useState(false);
  const [isButtonPermanentlyEnabled, setIsButtonPermanentlyEnabled] = useState(false);

  const cfg = {
    faceMinRatio: tuning?.faceMinRatio ?? 0.14,
    faceMaxRatio: tuning?.faceMaxRatio ?? 0.36,
    centerTolX: tuning?.centerTolX ?? 0.06,
    centerTolY: tuning?.centerTolY ?? 0.08,
    detectFps: tuning?.detectFps ?? 14,
  } as const;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      (v as any).srcObject = stream;
      v.play().catch(() => {});
    } catch {
      (v as HTMLVideoElement).srcObject = stream as any;
      v.play().catch(() => {});
    }
    const track = stream.getVideoTracks?.()[0];
    const s = track?.getSettings?.();
    if (s?.width && s?.height) setResText(`${s.width}×${s.height}@${s.frameRate ?? "?"}fps`);
  }, [stream]);

  // Brightness sampler
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      const c = samplerCanvasRef.current;
      if (!v || !c) { raf = requestAnimationFrame(tick); return; }
      const vw = v.videoWidth || 0, vh = v.videoHeight || 0;
      if (vw === 0 || vh === 0) { raf = requestAnimationFrame(tick); return; }

      if (c.width !== vw) c.width = vw;
      if (c.height !== vh) c.height = vh;

      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) { raf = requestAnimationFrame(tick); return; }

      const dw = 160, dh = Math.max(1, Math.round(dw * (vh / Math.max(1, vw))));
      ctx.drawImage(v, 0, 0, dw, dh);
      const img = ctx.getImageData(0, 0, dw, dh).data;

      let sum = 0;
      for (let i = 0; i < img.length; i += 4) {
        const r = img[i] / 255, g = img[i + 1] / 255, b = img[i + 2] / 255;
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        sum += y;
      }
      const avg = sum / (img.length / 4);
      setBrightness(avg);

      let lev: BrightnessLevel = "Too dark";
      if (avg >= 0.80) lev = "Harsh";
      else if (avg >= 0.45) lev = "Good";
      else if (avg >= 0.25) lev = "Dim";
      setLevel(lev);

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Enable button permanently once aligned
  useEffect(() => {
    if (aligned && !isButtonPermanentlyEnabled) {
      setIsButtonPermanentlyEnabled(true);
    }
  }, [aligned, isButtonPermanentlyEnabled]);

  // Human: detector + mesh for a tight, stable box
  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let lastLog = 0;

    async function run() {
      const { default: Human } = await import("@vladmandic/human");
      const human = new Human({
        backend: "webgl",
        modelBasePath: "/models",
        debug: false,
        cacheSensitivity: 0,
        face: {
          enabled: true,
          detector: { enabled: true, modelPath: "blazeface.json", maxDetected: 1, minConfidence: 0.15, skipFrames: 0 },
          mesh: { enabled: true, modelPath: "facemesh.json" },
          iris: { enabled: false },
          emotion: { enabled: false },
          description: { enabled: false },
          antispoof: { enabled: false },
          liveness: { enabled: false },
        },
        body: { enabled: false },
        hand: { enabled: false },
        object: { enabled: false },
      });

      try {
        if (typeof human.tf.findBackend === "function" && human.tf.findBackend("webgpu")) {
          await human.tf.removeBackend?.("webgpu");
        }
      } catch {}
      await human.tf.setBackend("webgl");
      await human.tf.ready();
      await human.load();
      await human.warmup();

      const loop = async () => {
        if (disposed) return;
        const v = videoRef.current;
        if (!v || v.videoWidth === 0 || v.videoHeight === 0) {
          timer = window.setTimeout(loop, 80) as unknown as number;
          return;
        }
        const vw = v.videoWidth, vh = v.videoHeight;

        const res = await human.detect(v);
        const f = res.face?.[0];

        let x1: number | null = null, y1: number | null = null, x2: number | null = null, y2: number | null = null;

        if (f?.mesh && f.mesh.length >= 468) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const pt of f.mesh as Array<[number, number, number?]>) {
            const px = pt[0], py = pt[1];
            if (!valid(px) || !valid(py)) continue;
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
          }
          if (Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minY) && Number.isFinite(maxY)) {
            x1 = minX; y1 = minY; x2 = maxX; y2 = maxY;
          }
        }

        if ((x1 === null || y1 === null || x2 === null || y2 === null) && f?.box) {
          const b0 = f.box[0], b1 = f.box[1];
          if (Array.isArray(b0) && Array.isArray(b1) && valid(b0[0]) && valid(b0[1]) && valid(b1[0]) && valid(b1[1])) {
            x1 = b0[0]; y1 = b0[1]; x2 = b1[0]; y2 = b1[1];
          }
        }

        if (x1 !== null && y1 !== null && x2 !== null && y2 !== null && vw > 0 && vh > 0) {
          const padX = (x2 - x1) * 0.08;
          const padY = (y2 - y1) * 0.12;
          x1 = Math.max(0, x1 - padX);
          y1 = Math.max(0, y1 - padY);
          x2 = Math.min(vw, x2 + padX);
          y2 = Math.min(vh, y2 + padY);

          let nx = (x1 / vw), ny = (y1 / vh), nw = ((x2 - x1) / vw), nh = ((y2 - y1) / vh);
          nx = clamp01(nx); ny = clamp01(ny); nw = clamp01(nw); nh = clamp01(nh);

          if (nw > 0.01 && nh > 0.01) {
            const box = { x: nx, y: ny, w: nw, h: nh };
            setFaceBox(box);

            const cx = box.x + box.w / 2;
            const cy = box.y + box.h / 2;
            const goodWidth = box.w >= cfg.faceMinRatio && box.w <= cfg.faceMaxRatio;
            const goodCenterX = Math.abs(cx - 0.5) <= cfg.centerTolX;
            const goodCenterY = Math.abs(cy - 0.5) <= cfg.centerTolY;
            const ok = goodWidth && goodCenterX && goodCenterY;

            setAligned(ok);
            onStatus?.(ok);

            const now = performance.now();
            if (now - lastLog > 600) {
              lastLog = now;
              console.log("[Setup] box", box, {
                cx: +((cx - 0.5) * 100).toFixed(1) + "%",
                cy: +((cy - 0.5) * 100).toFixed(1) + "%",
                goodWidth, goodCenterX, goodCenterY, ok
              });
            }
          } else {
            setFaceBox(null);
            setAligned(false);
            onStatus?.(false);
          }
        } else {
          setFaceBox(null);
          setAligned(false);
          onStatus?.(false);
        }

        const interval = Math.max(50, Math.round(1000 / cfg.detectFps));
        timer = window.setTimeout(loop, interval) as unknown as number;
      };

      loop();
    }

    run().catch((e) => console.warn("[FaceSetupAssistant] detector init failed:", e));

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [cfg.detectFps, cfg.centerTolX, cfg.centerTolY, cfg.faceMaxRatio, cfg.faceMinRatio, onStatus]);

  // Enable button permanently once aligned
  useEffect(() => {
    if (aligned && !isButtonPermanentlyEnabled) {
      setIsButtonPermanentlyEnabled(true);
    }
  }, [aligned, isButtonPermanentlyEnabled]);

  const brightnessPct = Math.round(brightness * 100);

  const hint = (() => {
    if (!faceBox) return "Detecting face…";
    const cx = faceBox.x + faceBox.w / 2;
    const cy = faceBox.y + faceBox.h / 2;
    if (faceBox.w < cfg.faceMinRatio) return "Move a bit closer";
    if (faceBox.w > cfg.faceMaxRatio) return "Move a bit back";
    if (Math.abs(cx - 0.5) > cfg.centerTolX) return cx < 0.5 ? "Move right" : "Move left";
    if (Math.abs(cy - 0.5) > cfg.centerTolY) return cy < 0.5 ? "Move down" : "Move up";
    return "Perfect!";
  })();

  // Centered target band dims
  const bandWidth = (cfg.faceMaxRatio - cfg.faceMinRatio);
  const bandX = 0.5 - bandWidth / 2;
  const bandY = 0.2;
  const bandH = 0.6;

  const showGuides = !aligned; // 🔴 hide dotted guides when aligned (green)

  return (
    <div className="w-full h-full grid place-items-center">
      <div
        className={`relative ${compact ? "w-[640px] h-[360px]" : "w-[860px] h-[484px]"} rounded-2xl overflow-hidden border shadow bg-black`}
      >
        {/* Video */}
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline
          muted
          autoPlay
        />

        {/* Hidden canvas for brightness sampling */}
        <canvas ref={samplerCanvasRef} className="hidden" />

        {/* Overlay */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none">
          {/* Rule-of-thirds grid (hidden when aligned) */}
          {showGuides && (
            <>
              <line x1="33.33%" y1="0" x2="33.33%" y2="100%" stroke="white" strokeOpacity="0.25" />
              <line x1="66.66%" y1="0" x2="66.66%" y2="100%" stroke="white" strokeOpacity="0.25" />
              <line x1="0" y1="33.33%" x2="100%" y2="33.33%" stroke="white" strokeOpacity="0.25" />
              <line x1="0" y1="66.66%" x2="100%" y2="66.66%" stroke="white" strokeOpacity="0.25" />
            </>
          )}

          {/* Target band (hidden when aligned) */}
          {showGuides && (
            <rect
              x={`${bandX * 100}%`}
              y={`${bandY * 100}%`}
              width={`${bandWidth * 100}%`}
              height={`${bandH * 100}%`}
              fill="none"
              stroke="red"
              strokeDasharray="8,8"
              strokeWidth="2"
              opacity="0.9"
            />
          )}

          {/* Live face box: solid green when aligned; orange when not */}
          {faceBox && valid(faceBox.x) && valid(faceBox.y) && valid(faceBox.w) && valid(faceBox.h) && faceBox.w > 0 && faceBox.h > 0 && (
            <rect
              x={`${clamp01(faceBox.x) * 100}%`}
              y={`${clamp01(faceBox.y) * 100}%`}
              width={`${clamp01(faceBox.w) * 100}%`}
              height={`${clamp01(faceBox.h) * 100}%`}
              fill={aligned ? "rgba(50,205,50,0.15)" : "rgba(255,165,0,0.15)"}
              stroke={aligned ? "lime" : "orange"}
              strokeWidth="3"
            />
          )}

          {/* Center tolerance crosshair (hidden when aligned) */}
          {showGuides && (
            <rect
              x={`${(0.5 - cfg.centerTolX) * 100}%`}
              y={`${(0.5 - cfg.centerTolY) * 100}%`}
              width={`${cfg.centerTolX * 2 * 100}%`}
              height={`${cfg.centerTolY * 2 * 100}%`}
              fill="none"
              stroke="red"
              strokeDasharray="4,6"
              strokeWidth="1.5"
              opacity="0.8"
            />
          )}
        </svg>

        {/* HUD */}
        <div className="absolute left-3 top-3 z-20 px-2 py-1 rounded bg-black/55 text-white text-xs">
          Res: {resText}
        </div>
        <div className="absolute right-3 top-3 z-20 px-2 py-1 rounded bg-black/55 text-white text-xs">
          Light: <b>{level}</b> <span className="opacity-80">({brightnessPct}%)</span>
        </div>

        {/* Status chip */}
        <div
          className={`absolute left-1/2 -translate-x-1/2 bottom-14 z-20 px-3 py-1 rounded-full text-sm font-medium ${
            aligned ? "bg-green-600 text-white" : "bg-red-600 text-white"
          }`}
        >
          {hint}
        </div>
      </div>

      {/* Start Interview button */}
      {showConfirmButton && (
        <div className="mt-3 flex justify-center"> {/* Positioned below the video stream */}
          <button
            onClick={onConfirm}
            disabled={!isButtonPermanentlyEnabled}
            className={`px-4 py-2 rounded-lg text-sm font-medium shadow ${
              isButtonPermanentlyEnabled ? "bg-white text-gray-900 hover:bg-gray-100" : "bg-gray-300 text-gray-600 cursor-not-allowed"
            }`}
            title={isButtonPermanentlyEnabled ? "Start the interview" : "Align face and lighting first"}
          >
            Start Interview
          </button>
        </div>
      )}

      {/* Tips */}
      <div className="mt-3 text-xs text-gray-600 text-center max-w-[860px]">
        Tips: Face a window or soft light. Avoid strong backlight. Keep your face centered; when the box turns green, tap Start.
      </div>
    </div>
  );
}
