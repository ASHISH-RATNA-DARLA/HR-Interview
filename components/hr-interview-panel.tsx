// components/hr-interview-panel.tsx
"use client"

import type React from "react"
import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Send, SkipForward, Volume2, Mic, MicOff, Info, Lock } from "lucide-react"
import { cn } from "@/lib/utils"
import Lottie from "react-lottie-player"
import micEnabledAnim from "@/lib/lottie/enable-mic.json"
import voiceLineAnim from "@/lib/lottie/voice-line-wave.json"

import EmotionDetector, { EmotionDetectorHandle } from "@/components/EmotionDetector"
import FaceSetupAssistant from "@/components/FaceSetupAssistant"

declare global {
  interface Window {
    __hrVideoStream?: MediaStream | null
    __hrAudioStream?: MediaStream | null
    __hrStopMedia?: () => void
  }
}

interface HRInterviewPanelProps {
  question: string
  onNextQuestion: () => void
  isLastQuestion: boolean
  interviewMode: "text" | "video"
}

type VoiceGender = "male" | "female"

export function HRInterviewPanel({
  question,
  onNextQuestion,
  isLastQuestion,
  interviewMode,
}: HRInterviewPanelProps) {
  const [hrAnswerText, setHRAnswerText] = useState("")
  const [hrThinkTime, setHRThinkTime] = useState(15)
  const [hrAnswerTime, setHRAnswerTime] = useState(60)
  const [isHRThinking, setIsHRThinking] = useState(true)
  const [hasStartedAnswering, setHasStartedAnswering] = useState(false)

  // Interview session state
  const [hasHRInterviewStarted, setHasHRInterviewStarted] = useState(interviewMode === "video")
  // Setup gate: shown immediately in video mode
  const [needsSetup, setNeedsSetup] = useState(interviewMode === "video")

  // media
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null)
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null)
  const [isMicMuted, setIsMicMuted] = useState(false)
  const micTrackRef = useRef<MediaStreamTrack | null>(null)

  // TTS
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [voiceGender, setVoiceGender] = useState<VoiceGender>("male")
  const [chosenVoice, setChosenVoice] = useState<SpeechSynthesisVoice | null>(null)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const ttsUtterRef = useRef<SpeechSynthesisUtterance | null>(null)
  const [pendingUtterance, setPendingUtterance] = useState<string | null>(null)

  // TTS warmup & policy pause tracking
  const ttsWarmedRef = useRef(false)
  const policyPausedRef = useRef(false)
  const firstSpeakDoneRef = useRef(false)

  // Lotties
  const lottieRef = useRef<any>(null)        // mic animation
  const voiceWaveRef = useRef<any>(null)     // wave animation
  const lottieReadyRef = useRef(false)

  const questionRef = useRef<string>("")

  // ❄️ Freeze state (penalty on multi-person)
  const [isFrozen, setIsFrozen] = useState(false)
  const [freezeSecondsLeft, setFreezeSecondsLeft] = useState(3)

  // detector ref (for manual save)
  const detectorRef = useRef<EmotionDetectorHandle | null>(null)

  // 🛡 ensure only one save happens at the end of interview
  const saveOnceRef = useRef(false)
  const saveInterviewOnce = useCallback(async () => {
    if (saveOnceRef.current) return
    saveOnceRef.current = true
    try {
      await detectorRef.current?.finalizeAndSave()
    } finally {
      stopMedia()
      onNextQuestion()
    }
  }, [onNextQuestion]) // stopMedia captured below

  const formatHRTime = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`

  // ---------- Save-on-submit ----------
  const handleSubmitHRAnswer = useCallback(() => {
    if (isLastQuestion) {
      void saveInterviewOnce()
    } else {
      onNextQuestion()
    }
  }, [onNextQuestion, isLastQuestion, saveInterviewOnce])

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setHRAnswerText(value)
    if (interviewMode === "text" && !hasStartedAnswering && value.trim().length > 0) {
      setHasStartedAnswering(true)
    }
  }

  // Broadcast video stream to sidebar if needed
  const broadcastStream = useCallback((stream: MediaStream | null) => {
    window.__hrVideoStream = stream
    window.dispatchEvent(new CustomEvent("hr-video-stream"))
  }, [])

  // ===== HD camera with graceful fallback & logging =====
  const startCamera = useCallback(async () => {
    // reuse existing
    if (window.__hrVideoStream) {
      // IMPORTANT: do not broadcast yet during setup — keep left card blank
      setVideoStream(window.__hrVideoStream)
      return
    }

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
        })
      } catch {
        return null
      }
    }

    const order: Array<[number, number]> = [
      [1280, 720],
      [960, 540],
      [640, 480],
    ]

    let stream: MediaStream | null = null
    for (const [w, h] of order) {
      stream = await tryGet(w, h)
      if (stream) break
    }

    if (!stream) {
      console.error("[Camera] Failed to acquire video stream at any resolution")
      return
    }

    // Keep it local for setup; no broadcast until user confirms
    setVideoStream(stream)

    // Log negotiated resolution
    const vtrack = stream.getVideoTracks?.()[0]
    const s = vtrack?.getSettings?.()
    if (s?.width && s?.height) {
      console.log(`[Camera] Using ${s.width}×${s.height} @ ${s.frameRate ?? "?"}fps`)
      if ((s.height as number) < 600) {
        console.warn("[Camera] Height < 600px — iris landmarks may be unreliable; HD recommended.")
      }
    }
  }, [])

  const startMic = useCallback(async () => {
    if (window.__hrAudioStream) {
      setAudioStream(window.__hrAudioStream)
      const t = window.__hrAudioStream.getAudioTracks()[0]
      micTrackRef.current = t || null
      if (t) t.enabled = true
      setIsMicMuted(false)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      setAudioStream(stream)
      const t = stream.getAudioTracks()[0]
      micTrackRef.current = t || null
      if (t) t.enabled = true
      setIsMicMuted(false)
    } catch (err) {
      console.error("Microphone start failed:", err)
    }
  }, [])

  // Explicit stop at end of session
  const stopMedia = useCallback(() => {
    if (videoStream) {
      videoStream.getTracks().forEach((t) => t.stop())
      setVideoStream(null)
      window.__hrVideoStream = null
      window.dispatchEvent(new CustomEvent("hr-video-stream"))
    }
    if (audioStream) {
      audioStream.getTracks().forEach((t) => t.stop())
      setAudioStream(null)
      micTrackRef.current = null
      window.__hrAudioStream = null
    }
  }, [videoStream, audioStream])

  useEffect(() => {
    window.__hrStopMedia = stopMedia
  }, [stopMedia])

  // ---------- Beep utility ----------
  const beep = useCallback((ms = 300, freq = 880) => {
    try {
      const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext
      const ctx = new Ctx()
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = "sine"
      o.frequency.value = freq
      o.connect(g)
      g.connect(ctx.destination)
      o.start()
      g.gain.setValueAtTime(0.001, ctx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000)
      o.stop(ctx.currentTime + ms / 1000 + 0.02)
    } catch {}
  }, [])

  // ---------- TTS Warmup ----------
  const warmupTTS = useCallback(() => {
    if (ttsWarmedRef.current) return
    try {
      const u = new SpeechSynthesisUtterance(" ")
      u.volume = 0
      u.rate = 1
      u.onend = () => {
        ttsWarmedRef.current = true
      }
      window.speechSynthesis.speak(u)
    } catch {}
  }, [])

  // ========== New flow for VIDEO mode ==========
  // Immediately enter "interview started" state in video mode and show setup assistant
  useEffect(() => {
    if (interviewMode !== "video") return
    setHasHRInterviewStarted(true)
    setNeedsSetup(true)
    // prepare hardware, but do not broadcast yet
    startCamera()
    startMic()
    warmupTTS()
    // Do NOT set pendingUtterance here; wait until user confirms in assistant
  }, [interviewMode, startCamera, startMic, warmupTTS])

  // Called when user presses "Start Interview" inside the assistant
  const handleConfirmSetup = useCallback(() => {
    if (!videoStream) return
    setNeedsSetup(false)

    // Now broadcast to the left "Presence" card
    window.__hrVideoStream = videoStream
    window.dispatchEvent(new CustomEvent("hr-video-stream"))

    // Queue TTS to read the current question
    setPendingUtterance(question)
  }, [videoStream, question])

  // ---------------- TTS (voices) ----------------
  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis.getVoices())
    load()
    window.speechSynthesis.onvoiceschanged = load
    return () => {
      window.speechSynthesis.onvoiceschanged = null
    }
  }, [])

  const selectPreferredVoice = useCallback(
    (all: SpeechSynthesisVoice[], gender: VoiceGender): SpeechSynthesisVoice | null => {
      const exactName = gender === "male" ? "Google UK English Male" : "Google UK English Female"
      const byExact = all.find(v => v.name === exactName && v.lang === "en-GB")
      if (byExact) return byExact

      const googleGB = all.find(v => v.name.toLowerCase().includes("google") && v.lang === "en-GB")
      if (googleGB) return googleGB

      const anyGB = all.find(v => v.lang === "en-GB")
      if (anyGB) return anyGB

      const anyEN = all.find(v => v.lang?.toLowerCase().startsWith("en"))
      if (anyEN) return anyEN

      return all[0] || null
    },
    []
  )

  useEffect(() => {
    if (!voices.length) return
    let v = selectPreferredVoice(voices, voiceGender)

    if (voiceGender === "male" && v && /female/i.test(v.name)) {
      const maleFallback =
        voices.find(vv => /male/i.test(vv.name) && vv.lang === "en-GB") ||
        voices.find(vv => /male/i.test(vv.name)) ||
        v
      v = maleFallback
    }
    if (voiceGender === "female" && v && /male/i.test(v.name)) {
      const femaleFallback =
        voices.find(vv => /female/i.test(vv.name) && vv.lang === "en-GB") ||
        voices.find(vv => /female/i.test(vv.name)) ||
        v
      v = femaleFallback
    }

    setChosenVoice(v || null)
  }, [voices, voiceGender, selectPreferredVoice])

  useEffect(() => {
    if (voices.length) warmupTTS()
  }, [voices, warmupTTS])

  const cancelTTS = useCallback(() => {
    try {
      window.speechSynthesis.cancel()
      setIsSpeaking(false)
      policyPausedRef.current = false
    } catch {}
  }, [])

  // Helper: start wave only when lottie is ready
  const startWaveIfReady = useCallback(() => {
    const wave = voiceWaveRef.current
    if (!wave || !lottieReadyRef.current) return false
    wave.goToAndPlay?.(0, true)
    return true
  }, [])

  const speakQuestion = useCallback((text: string) => {
    if (!text) return
    try {
      try { (window.speechSynthesis as any)?.resume?.() } catch {}

      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      if (chosenVoice) u.voice = chosenVoice
      u.lang = chosenVoice?.lang || "en-GB"

      u.rate = 0.92
      u.pitch = voiceGender === "male" ? 0.85 : 1.05
      u.volume = 1.0

      u.onstart = () => {
        setIsSpeaking(true)
        if (!startWaveIfReady()) {
          const t0 = performance.now()
          const tick = () => {
            if (startWaveIfReady()) return
            if (performance.now() - t0 < 300) requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }
      }
      u.onend = () => setIsSpeaking(false)
      u.onerror = () => setIsSpeaking(false)

      ttsUtterRef.current = u
      window.speechSynthesis.speak(u)
    } catch (e) {
      console.warn("TTS speak failed:", e)
    }
  }, [chosenVoice, voiceGender, startWaveIfReady])

  // speak only when queued AND voice ready (and not frozen)
  useEffect(() => {
    if (!hasHRInterviewStarted || needsSetup) return // wait until setup confirmed
    if (pendingUtterance && chosenVoice && !isFrozen) {
      if (!firstSpeakDoneRef.current) {
        requestAnimationFrame(() => {
          speakQuestion(pendingUtterance)
          firstSpeakDoneRef.current = true
        })
      } else {
        speakQuestion(pendingUtterance)
      }
      setPendingUtterance(null)
    }
  }, [pendingUtterance, chosenVoice, speakQuestion, hasHRInterviewStarted, isFrozen, needsSetup])

  // -------------- Mic Lottie follows mic mute --------------
  useEffect(() => {
    const api = lottieRef.current
    if (!api) return
    if (isMicMuted) {
      api.pause?.()
      api.goToAndStop?.(0, true)
    } else {
      api.play?.()
    }
  }, [isMicMuted])

  // ---------- Lock wave speed before first paint ----------
  useLayoutEffect(() => {
    const wave = voiceWaveRef.current
    lottieReadyRef.current = false
    if (!wave) return
    wave.setSpeed?.(0.15)
    wave.goToAndStop?.(0, true)
    wave.pause?.()
    requestAnimationFrame(() => { lottieReadyRef.current = true })
  }, [])

  // Control play/pause WITHOUT touching speed each time
  useEffect(() => {
    const wave = voiceWaveRef.current
    if (!wave) return
    if (isSpeaking && !isFrozen) {
      wave.goToAndPlay?.(0, true)
    } else {
      wave.pause?.()
      wave.goToAndStop?.(0, true)
    }
  }, [isSpeaking, isFrozen])

  // Mic toggle (no permission loss)
  const toggleMic = useCallback(() => {
    const track = micTrackRef.current ?? audioStream?.getAudioTracks()?.[0] ?? null
    if (!track) return
    const willEnable = !track.enabled
    track.enabled = willEnable
    setIsMicMuted(!willEnable)

    const api = lottieRef.current
    if (api) {
      if (willEnable) api.play?.()
      else {
        api.pause?.()
        api.goToAndStop?.(0, true)
      }
    }
  }, [audioStream])

  // ---------- Timers — gated by isFrozen ----------
  useEffect(() => {
    let t: NodeJS.Timeout
    if (isHRThinking && hasHRInterviewStarted && !hasStartedAnswering && !isFrozen && !needsSetup) {
      t = setInterval(() => {
        setHRThinkTime((prev) => {
          if (prev <= 1) {
            clearInterval(t)
            setIsHRThinking(false)
            setHasStartedAnswering(true)
            return 0
          }
          return prev - 1
        })
      }, 1000)
    }
    return () => clearInterval(t)
  }, [isHRThinking, hasHRInterviewStarted, hasStartedAnswering, isFrozen, needsSetup])

  useEffect(() => {
    let t: NodeJS.Timeout
    if (hasStartedAnswering && hrAnswerTime > 0 && hasHRInterviewStarted && !isFrozen && !needsSetup) {
      t = setInterval(() => setHRAnswerTime((prev) => (prev <= 1 ? 0 : prev - 1)), 1000)
    } else if (hasStartedAnswering && hrAnswerTime === 0 && hasHRInterviewStarted && !isFrozen && !needsSetup) {
      handleSubmitHRAnswer()
    }
    return () => clearInterval(t)
  }, [hasStartedAnswering, hrAnswerTime, hasHRInterviewStarted, handleSubmitHRAnswer, isFrozen, needsSetup])

  // ---------- Question change resets timers/text ----------
  useEffect(() => {
    const prevQuestion = questionRef.current
    questionRef.current = question
    if (hasHRInterviewStarted && prevQuestion && prevQuestion !== question) {
      setHRThinkTime(15)
      setHRAnswerTime(60)
      setIsHRThinking(true)
      setHasStartedAnswering(false)
      setHRAnswerText("")
      if (!isFrozen && !needsSetup) setPendingUtterance(question)
    }
  }, [question, hasHRInterviewStarted, isFrozen, needsSetup])

  // ---------- Policy events from detector (multi-person) ----------
  const handlePolicyEvent = useCallback((e: { type: "multi-person-detected" }) => {
    if (e.type !== "multi-person-detected") return

    try {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.pause()
        policyPausedRef.current = true
        setIsSpeaking(false)
      }
    } catch {}

    beep()
    setFreezeSecondsLeft(3)
    setIsFrozen(true)

    const interval = setInterval(() => {
      setFreezeSecondsLeft((s) => (s > 0 ? s - 1 : 0))
    }, 1000)

    setTimeout(() => {
      clearInterval(interval)
      setIsFrozen(false)
      try {
        if (policyPausedRef.current && (window.speechSynthesis as any).paused) {
          (window.speechSynthesis as any).resume()
        }
      } catch {}
      policyPausedRef.current = false
    }, 3000)
  }, [beep])

  const renderAnswerInterface = () =>
    interviewMode === "text" ? (
      <Textarea
        placeholder="Type your answer here..."
        value={hrAnswerText}
        onChange={handleTextChange}
        className="h-[14vh] min-h-0 resize-none"
        disabled={isFrozen}
      />
    ) : (
      <div className="h-[14vh]" />
    )

  const showSetup = hasHRInterviewStarted && interviewMode === "video" && videoStream && needsSetup

  return (
    <Card className="h-full max-h-full grid grid-rows-[auto,1fr,auto] overflow-hidden shadow-lg">
      <CardHeader className="pt-3 pb-2 min-h-0">
        <div className="flex justify-between items-center mb-2">
          <CardTitle className="text-xl font-bold text-gray-800">Interview Question</CardTitle>

          {/* Voice gender selection only before session (text mode) */}
          {!hasHRInterviewStarted && interviewMode === "text" && (
            <div className="flex items-center gap-2 text-sm">
              <span className="mr-1 text-gray-600 flex items-center gap-1">
                HR Voice
                <Info className="h-4 w-4 text-gray-400" title="Select the voice used to read questions aloud" />
              </span>
              <Button
                size="sm"
                variant={voiceGender === "male" ? "default" : "outline"}
                className={cn("h-8 px-3", voiceGender === "male" ? "bg-blue-600 hover:bg-blue-700" : "")}
                onClick={() => setVoiceGender("male")}
                title='Use "Google UK English Male" (en-GB)'
              >
                Male
              </Button>
              <Button
                size="sm"
                variant={voiceGender === "female" ? "default" : "outline"}
                className={cn("h-8 px-3", voiceGender === "female" ? "bg-blue-600 hover:bg-blue-700" : "")}
                onClick={() => setVoiceGender("female")}
                title='Use "Google UK English Female" (en-GB)'
              >
                Female
              </Button>
            </div>
          )}

          {hasHRInterviewStarted && !needsSetup && (
            <div className="text-sm text-gray-600">
              {!hasStartedAnswering ? (
                <>
                  Think time:{" "}
                  <span className={cn("font-semibold", hrThinkTime <= 5 ? "text-red-500" : "text-gray-800")}>
                    {formatHRTime(hrThinkTime)}
                  </span>
                </>
              ) : (
                <>
                  Answer time:{" "}
                  <span className={cn("font-semibold", hrAnswerTime <= 10 ? "text-red-500" : "text-gray-800")}>
                    {formatHRTime(hrAnswerTime)}
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Intro block only for TEXT mode */}
        {!hasHRInterviewStarted && interviewMode === "text" ? (
          <div className="flex flex-col items-center justify-center py-8">
            <p className="text-lg text-gray-600 mb-2 text-center">Ready to begin your interview simulation?</p>
            <p className="text-xs text-gray-500 mb-2">
              Preferred: {voiceGender === "male" ? "Google UK English Male" : "Google UK English Female"} (en-GB)
            </p>
            <p className="text-xs text-gray-500 mb-5">
              Actual voice selected:{" "}
              <span className="font-medium">
                {chosenVoice ? `${chosenVoice.name} (${chosenVoice.lang})` : "Loading voices…"}
              </span>
            </p>
            <Button
              onClick={() => {
                setHasHRInterviewStarted(true)
                setPendingUtterance(question)
              }}
              className="py-3 px-6 text-lg"
              title="Start interview"
            >
              Start Interview
            </Button>
          </div>
        ) : (
          <>
            {/* Question + controls (hidden while setup is active) */}
            {!needsSetup && (
              <>
                <p className="text-lg text-gray-700">{question}</p>
                <div className="flex items-center justify-end mt-2 gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-gray-600 hover:text-blue-600"
                    onClick={() => (!chosenVoice ? setPendingUtterance(question) : speakQuestion(question))}
                    disabled={isSpeaking || isFrozen}
                    title={isSpeaking ? "Speaking…" : "Re-read Question"}
                  >
                    <Volume2 className="h-4 w-4 mr-1" /> {isSpeaking ? "Speaking…" : "Re-read Question"}
                  </Button>
                  {isSpeaking && (
                    <Button variant="ghost" size="sm" onClick={cancelTTS} title="Stop speaking" disabled={isFrozen}>
                      Stop
                    </Button>
                  )}
                </div>
              </>
            )}

            {/* Main area */}
            <div className="mt-3 relative rounded-xl overflow-hidden bg-gray-50 border h-[48vh] min-h-0">
              {/* ❄️ FREEZE OVERLAY */}
              {isFrozen && !needsSetup && (
                <>
                  <div className="absolute inset-0 z-30 backdrop-blur-sm bg-black/20" />
                  <div className="absolute inset-0 z-40 flex items-center justify-center">
                    <div className="bg-white/95 border rounded-2xl shadow-xl px-6 py-5 text-center max-w-xs">
                      <div className="mx-auto mb-2 w-12 h-12 flex items-center justify-center rounded-full bg-red-50 border border-red-200">
                        <Lock className="w-6 h-6 text-red-600" />
                      </div>
                      <div className="font-semibold text-gray-800">Multiple faces detected</div>
                      <div className="text-sm text-gray-600 mt-1">Interview is temporarily paused</div>
                      <div className="mt-3 text-xs text-gray-500">Resuming in {freezeSecondsLeft}s…</div>
                    </div>
                  </div>
                </>
              )}

              {/* Setup assistant: full focus UI; no left preview broadcast yet */}
              {showSetup ? (
                <div className="absolute inset-0 flex items-center justify-center bg-white">
                  <FaceSetupAssistant
                    stream={videoStream}
                    onConfirm={handleConfirmSetup}
                    // optional status feedback: (ok) => {}
                    tuning={{ faceMinRatio: 0.14, faceMaxRatio: 0.36, centerTolX: 0.06, centerTolY: 0.08 }}
                  />
                </div>
              ) : (
                <>
                  {/* wave shifted up 20px and no autoplay */}
                  <div className="absolute inset-0 -translate-y-[20px]">
                    <Lottie
                      ref={voiceWaveRef}
                      animationData={voiceLineAnim}
                      loop
                      play={false}
                      style={{ width: "100%", height: "100%" }}
                    />
                  </div>

                  {/* Mic overlay smaller, centered bottom with padding above */}
                  <div className="pointer-events-auto absolute left-1/2 -translate-x-1/2 bottom-3 flex flex-col items-center pb-3">
                    <Button
                      onClick={toggleMic}
                      variant={isMicMuted ? "outline" : "default"}
                      className={cn(
                        "h-6 px-2 py-0 text-[11px] mb-1",
                        isMicMuted ? "border-gray-300 text-gray-700" : "bg-blue-600 hover:bg-blue-700"
                      )}
                      title={isMicMuted ? "Turn mic on" : "Mute mic"}
                      disabled={isFrozen}
                    >
                      {isMicMuted ? <><MicOff className="h-3 w-3 mr-1" /> Unmute</> : <><Mic className="h-3 w-3 mr-1" /> Mute</>}
                    </Button>

                    <div className="relative w-24 aspect-square rounded-lg overflow-hidden bg-white border shadow-sm">
                      <Lottie
                        ref={lottieRef}
                        animationData={micEnabledAnim}
                        loop
                        play
                        style={{ width: "100%", height: "100%" }}
                      />
                      {isMicMuted && (
                        <div className="absolute inset-0 flex items-center justify-center bg-white/70">
                          <MicOff className="h-7 w-7 text-gray-500" />
                        </div>
                      )}
                    </div>
                    <div className="mt-1 text-[10px] text-gray-600">
                      {isMicMuted ? "Muted" : "Listening…"}
                    </div>
                  </div>

                  {/* 🔒 Invisible detector hookup */}
                  {hasHRInterviewStarted && videoStream && !needsSetup && (
                    <div
                      className="absolute"
                      style={{ width: 1, height: 1, opacity: 0, pointerEvents: "none", left: 0, top: 0 }}
                    >
                      <EmotionDetector
                        ref={detectorRef}
                        externalStream={videoStream}
                        showVideo={false}
                        saveMode="manual"      // only save at successful end
                        paused={isFrozen}      // freeze inference during penalty
                        onPolicyEvent={handlePolicyEvent}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </CardHeader>

      {/* While setup is active, hide the answer box & footer to keep the UI focused */}
      {!needsSetup && hasHRInterviewStarted && (
        <>
          <CardContent className="flex-1 min-h-0 p-3 pt-2">
            {renderAnswerInterface()}
          </CardContent>

          <CardFooter className="flex justify-between items-center pt-3 border-t">
            <div className="text-sm text-gray-600 truncate">
              Mode: <span className="font-semibold capitalize">{interviewMode}</span>
              {" • TTS voice: "}
              <span className="font-medium">{chosenVoice ? chosenVoice.name : "Loading…"}</span>
              {isFrozen ? " • Paused (multiple faces detected)" : ""}
            </div>
            <div className="flex gap-2">
              {/* Finish/Skip also saves when it's the last question */}
              <Button
                variant="outline"
                onClick={() => {
                  if (isLastQuestion) {
                    void saveInterviewOnce()
                  } else {
                    onNextQuestion()
                  }
                }}
                title="Skip to the next question"
                disabled={isFrozen}
              >
                <SkipForward className="h-4 w-4 mr-2" />
                {isLastQuestion ? "Finish Interview" : "Skip Question"}
              </Button>

              <Button onClick={handleSubmitHRAnswer} title="Submit your answer" disabled={isFrozen}>
                <Send className="h-4 w-4 mr-2" />
                {isLastQuestion ? "Submit Interview" : "Submit Answer"}
              </Button>
            </div>
          </CardFooter>
        </>
      )}
    </Card>
  )
}
