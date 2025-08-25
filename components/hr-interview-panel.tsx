// components/hr-interview-panel.tsx
"use client"

/// <reference lib="dom" />
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
    __hrStopMedia?: () => void;
  }

  interface SpeechRecognitionEvent extends Event {
    readonly resultIndex: number;
    readonly results: SpeechRecognitionResultList;
  }

  interface SpeechRecognitionErrorEvent extends Event {
    readonly error: SpeechRecognitionErrorCode;
    readonly message: string;
  }

  type SpeechRecognitionErrorCode =
    | "no-speech"
    | "aborted"
    | "audio-capture"
    | "network"
    | "not-allowed"
    | "service-not-allowed"
    | "bad-grammar"
    | "language-not-supported";
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

  // Speech Recognition
  const [speechSupported, setSpeechSupported] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [isSpeechListening, setIsSpeechListening] = useState(false);
  const [finalTranscript, setFinalTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const recognitionRef = useRef<any | null>(null); // Use any for now to bypass type issues
  const shouldAutoRestartRef = useRef(false);
  const finalTranscriptRef = useRef("");

  // New refs for mic/TTS sync and transcript
  const userMicPrefRef = useRef(false); // true = unmuted, false = muted (user's explicit preference), default to muted
  const autoMutedForTTSRef = useRef(false); // true if mic was auto-muted for TTS
  const prevMicEnabledRef = useRef(false); // stores micTrack.enabled state before auto-mute, default to false
  const transcriptsRef = useRef<Array<{ qId: string; q: string; tId: string; t: string }>>([]);
  const currentQuestionIdRef = useRef<string>("");
  const currentTranscriptionIdRef = useRef<string>("");

  // Initialize transcripts from localStorage and set initial question ID
  useEffect(() => {
    try {
      const storedTranscripts = localStorage.getItem("hr_stt_transcripts");
      if (storedTranscripts) {
        const parsed = JSON.parse(storedTranscripts);
        if (Array.isArray(parsed) && parsed.length > 0) {
          transcriptsRef.current = parsed;
        }
      }
    } catch (e) {
      console.error("Failed to load transcripts from localStorage", e);
    }
    
    // Set initial question ID
    if (question) {
      currentQuestionIdRef.current = question;
      currentTranscriptionIdRef.current = question;
    }
  }, [question]);

  // Interview session state
  const [hasHRInterviewStarted, setHasHRInterviewStarted] = useState(interviewMode === "video")
  // Setup gate: shown immediately in video mode
  const [needsSetup, setNeedsSetup] = useState(interviewMode === "video")

  // media
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null)
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null)
  const [isMicMuted, setIsMicMuted] = useState(true); // Default to muted
  const micTrackRef = useRef<MediaStreamTrack | null>(null);

  // TTS
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceGender, setVoiceGender] = useState<VoiceGender>("male");
  const [chosenVoice, setChosenVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const ttsUtterRef = useRef<SpeechSynthesisUtterance | null>(null);
  const [pendingUtterance, setPendingUtterance] = useState<string | null>(null);

  // TTS warmup & policy pause tracking
  const ttsWarmedRef = useRef(false);
  const policyPausedRef = useRef(false);
  const firstSpeakDoneRef = useRef(false);

  // Lotties
  const lottieRef = useRef<any>(null); // mic animation
  const voiceWaveRef = useRef<any>(null); // wave animation
  const lottieReadyRef = useRef(false);

  const questionRef = useRef<string>("");

  // ❄️ Freeze state (penalty on multi-person)
  const [isFrozen, setIsFrozen] = useState(false);
  const [freezeSecondsLeft, setFreezeSecondsLeft] = useState(3);
  const [isProcessingAction, setIsProcessingAction] = useState(false); // New state for action processing

  // detector ref (for manual save)
  const detectorRef = useRef<EmotionDetectorHandle | null>(null);

  // 🛡 ensure only one save happens at the end of interview
  const saveOnceRef = useRef(false);
  const saveInterviewOnce = useCallback(async () => {
    if (saveOnceRef.current) return;
    saveOnceRef.current = true;
    let saveSuccessful = false; // Track if save was successful
    try {
      // Save emotion detection data
      await detectorRef.current?.finalizeAndSave();

      // Save final interview report with Q&A numbering
      if (transcriptsRef.current.length > 0) {
        try {
          const report = {
            interviewDate: new Date().toISOString(),
            totalQuestions: transcriptsRef.current.length,
            transcripts: transcriptsRef.current.map(t => ({
              qId: t.qId,
              question: t.q,
              tId: t.tId,
              transcription: t.t
            }))
          };

          // Send to API route
          const response = await fetch('/api/save-qa', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(report),
          });

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          console.log("[Interview] Final report saved via API.");
          saveSuccessful = true; // Mark as successful

        } catch (e) {
          console.error("Failed to save final interview report via API:", e);
        }
      } else {
        console.log("[Interview] No transcripts to save. transcriptsRef.current is empty.");
        saveSuccessful = true; // Consider it successful if nothing to save
      }
    } finally {
      stopMedia(); // Always stop media
      // Only navigate if save was successful or if there were no transcripts to save
      if (saveSuccessful) {
        onNextQuestion();
      } else {
        console.warn("[Interview] Not navigating to next question because save failed.");
      }
    }
  }, [onNextQuestion]); // stopMedia captured below

  const formatHRTime = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  // Save interview data to localStorage for backup (no longer downloads files)
  const saveInterviewToLocalStorage = useCallback(async (data: any, filename: string) => {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dataStr = JSON.stringify(data, null, 2);
      const backupKey = `backup_${filename}_${timestamp}`;
      localStorage.setItem(backupKey, dataStr);
      console.log(`[Backup] Saved to localStorage: ${backupKey}`);
    } catch (e) {
      console.error("Failed to save interview data to localStorage:", e);
    }
  }, []);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setHRAnswerText(value);
    if (interviewMode === "text" && !hasStartedAnswering && value.trim().length > 0) {
      setHasStartedAnswering(true);
    }
  };

  // Broadcast video stream to sidebar if needed
  const broadcastStream = useCallback((stream: MediaStream | null) => {
    window.__hrVideoStream = stream;
    window.dispatchEvent(new CustomEvent("hr-video-stream"));
  }, []);

  // ===== HD camera with graceful fallback & logging =====
  const startCamera = useCallback(async () => {
    // reuse existing
    if (window.__hrVideoStream) {
      // IMPORTANT: do not broadcast yet during setup — keep left card blank
      setVideoStream(window.__hrVideoStream);
      return;
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

    let stream: MediaStream | null = null;
    for (const [w, h] of order) {
      stream = await tryGet(w, h);
      if (stream) break;
    }

    if (!stream) {
      console.error("[Camera] Failed to acquire video stream at any resolution");
      return;
    }

    // Keep it local for setup; no broadcast until user confirms
    setVideoStream(stream);

    // Log negotiated resolution
    const vtrack = stream.getVideoTracks?.()[0];
    const s = vtrack?.getSettings?.();
    if (s?.width && s?.height) {
      console.log(`[Camera] Using ${s.width}×${s.height} @ ${s.frameRate ?? "?"}fps`);
      if ((s.height as number) < 600) {
        console.warn("[Camera] Height < 600px — iris landmarks may be unreliable; HD recommended.");
      }
    }
  }, []);

  const startMic = useCallback(async () => {
    if (window.__hrAudioStream) {
      setAudioStream(window.__hrAudioStream);
      const t = window.__hrAudioStream.getAudioTracks()[0];
      micTrackRef.current = t || null;
      if (t) t.enabled = false; // Keep muted by default
      setIsMicMuted(true); // Keep muted by default
      userMicPrefRef.current = false; // Default to muted preference
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      setAudioStream(stream);
      const t = stream.getAudioTracks()[0];
      micTrackRef.current = t || null;
      if (t) t.enabled = false; // Keep muted by default
      setIsMicMuted(true); // Keep muted by default
      userMicPrefRef.current = false; // Default to muted preference
    } catch (err) {
      console.error("Microphone start failed:", err);
    }
  }, []);

  // Explicit stop at end of session
  const stopMedia = useCallback(() => {
    if (videoStream) {
      videoStream.getTracks().forEach((t) => t.stop());
      setVideoStream(null);
      window.__hrVideoStream = null;
      window.dispatchEvent(new CustomEvent("hr-video-stream"));
    }
    if (audioStream) {
      audioStream.getTracks().forEach((t) => t.stop());
      setAudioStream(null);
      micTrackRef.current = null;
      window.__hrAudioStream = null;
    }
  }, [videoStream, audioStream]);

  useEffect(() => {
    window.__hrStopMedia = stopMedia;
  }, [stopMedia]);



  // Centralized STT start/stop helpers
  const startSTT = useCallback(() => {
    console.log("[STT] Attempting to start STT.");
    if (!speechSupported || !recognitionRef.current) {
      console.log("[STT] Not starting: speech not supported or recognitionRef missing.");
      return;
    }
    if (isSpeechListening) {
      console.log("[STT] Not starting: already listening.");
      return; // Already listening
    }
    
    // Additional safety check - ensure recognition is not in an active state
    try {
      if (recognitionRef.current.state === 'recording' || recognitionRef.current.state === 'starting') {
        console.log("[STT] Not starting: recognition already in active state:", recognitionRef.current.state);
        return;
      }
    } catch (e) {
      // State property might not exist in all browsers, continue
    }
    
    // Additional check - ensure we're not already listening
    if (isSpeechListening) {
      console.log("[STT] Not starting: already listening according to state");
      return;
    }
    
    // Force reset any existing recognition state
    try {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        console.log("[STT] Force stopped existing recognition before starting");
      }
    } catch (e) {
      console.log("[STT] Force stop before start failed (may already be stopped):", e);
    }
    
    // Wait a bit for the stop to take effect
    setTimeout(() => {
      try {
        setSpeechError(null);
        shouldAutoRestartRef.current = true;
        recognitionRef.current.start();
        setIsSpeechListening(true);
        setInterimTranscript(""); // Clear interim on start
        console.log("[STT] STT start() called successfully.");
      } catch (err) {
        setSpeechError("Could not start recognition. Try clicking Stop, then Start again.");
        console.error("[STT] Error calling start():", err);
      }
    }, 300); // Increased delay to allow stop to fully take effect
  }, [speechSupported, isSpeechListening]);

  const stopSTT = useCallback(() => {
    console.log("[STT] Attempting to stop STT.");
    if (!recognitionRef.current) {
      console.log("[STT] Not stopping: recognitionRef missing.");
      return;
    }
    shouldAutoRestartRef.current = false;
    try {
      recognitionRef.current.stop();
      setIsSpeechListening(false);
      setInterimTranscript(""); // Clear interim on stop
      console.log("[STT] STT stop() called.");
    } catch (err) {
      console.error("[STT] Error calling stop():", err);
    }
  }, []);

  // Force reset STT state - useful for question changes
  const forceResetSTT = useCallback(() => {
    console.log("[STT] Force resetting STT state");
    shouldAutoRestartRef.current = false;
    setIsSpeechListening(false);
    setInterimTranscript("");
    setFinalTranscript("");
    finalTranscriptRef.current = "";
    
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
        console.log("[STT] Force stop called");
      } catch (err) {
        console.log("[STT] Force stop failed (may already be stopped):", err);
      }
    }
  }, []);

  // Commit current transcript to local storage
  const commitCurrentTranscript = useCallback(() => {
    if (questionRef.current) {
      const final = [
        hrAnswerText,                 // typed text
        finalTranscriptRef.current,   // finalized STT
        interimTranscript             // last interim (if any)
      ].join(" ").replace(/\s+/g, " ").trim();

      // Always save entry, even if empty (null for transcription)
      const entry = { 
        qId: currentQuestionIdRef.current, 
        q: questionRef.current, 
        tId: currentQuestionIdRef.current, 
        t: final || null  // null if no transcription
      };
      
      try {
        const key = "hr_stt_transcripts";
        const existing = JSON.parse(localStorage.getItem(key) || "[]");
        const next = Array.isArray(existing) ? [...existing, entry] : [entry];
        localStorage.setItem(key, JSON.stringify(next));
        transcriptsRef.current = next;
        
        console.log(`[Transcript] Saved Q: "${questionRef.current}" T: ${final || "null"}`);
        
        // Auto-save current progress to localStorage after each question
        if (next.length > 0) {
          const progressData = {
            interviewDate: new Date().toISOString(),
            currentQuestion: currentQuestionIdRef.current,
            totalQuestions: next.length,
            transcripts: next,
            summary: next.map(t => ({
              qId: t.qId,
              question: t.q,
              tId: t.tId,
              transcription: t.t
            }))
          };
          
          // Save progress after each question to localStorage
          saveInterviewToLocalStorage(progressData, "hr_interview_progress");
        }
      } catch (e) {
        console.error("Failed to save transcript:", e);
      }
    }
    
    // Clear all buffers for fresh start
    finalTranscriptRef.current = "";
    setInterimTranscript("");
    setFinalTranscript("");
    setHRAnswerText("");
  }, [hrAnswerText, interimTranscript, saveInterviewToLocalStorage]);

  // Detect speech recognition support on client
  useEffect(() => {
    if (typeof window === "undefined") return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setSpeechSupported(!!SR);
  }, []);

  // Init speech recognition once on client
  useEffect(() => {
    if (!speechSupported || typeof window === "undefined") return;

    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const r = new SR();

    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-IN";

    r.onstart = () => {
      setIsSpeechListening(true);
      setSpeechError(null);
      console.log("[SR Event] onstart: STT is now listening.");
      
      // Track recognition state for debugging
      try {
        if (recognitionRef.current.state) {
          console.log("[SR Event] Recognition state:", recognitionRef.current.state);
        }
      } catch (e) {
        // State property might not exist in all browsers
      }
    };

    r.onerror = (e: SpeechRecognitionErrorEvent) => {
      // Handle specific error types gracefully
      if (e.error === "no-speech") {
        console.log("[SR Event] No speech detected - this is normal");
        // Don't show error for no-speech, just log it
        return;
      }
      
      if (e.error === "aborted") {
        console.log("[SR Event] Speech recognition aborted - this is normal");
        return;
      }
      
      // For other errors, show user-friendly message
      const errorMessages: Record<string, string> = {
        "audio-capture": "Microphone access issue. Please check permissions.",
        "network": "Network error. Please check your connection.",
        "not-allowed": "Microphone permission denied. Please allow access.",
        "service-not-allowed": "Speech recognition service unavailable.",
        "bad-grammar": "Language configuration issue.",
        "language-not-supported": "Language not supported. Using English."
      };
      
      const userMessage = errorMessages[e.error] || `Recognition error: ${e.error}`;
      setSpeechError(userMessage);
      console.error("[SR Event] onerror:", e.error, e.message);
    };

    r.onend = () => {
      setIsSpeechListening(false);
      console.log("[SR Event] onend: STT stopped.");
      // STT will be restarted explicitly by TTS onend or user action, not automatically here.
    };

    r.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const transcript = res[0].transcript;
        if (res.isFinal) {
          finalTranscriptRef.current += transcript + " ";
        } else {
          interim += transcript;
        }
      }
      setFinalTranscript(finalTranscriptRef.current);
      setInterimTranscript(interim);
    };

    recognitionRef.current = r;

    return () => {
      try {
        shouldAutoRestartRef.current = false;
        r.onstart = r.onend = r.onerror = r.onresult = null;
        r.stop();
      } catch {}
      recognitionRef.current = null;
    };
  }, [speechSupported]);

  // ---------- Save-on-submit ----------
  const handleSubmitHRAnswer = useCallback(async () => {
    if (isProcessingAction) return; // Prevent multiple clicks
    setIsProcessingAction(true);
    try {
      stopSTT(); // Stop STT immediately
      commitCurrentTranscript(); // Commit current answer
      if (isLastQuestion) {
        await saveInterviewOnce();
      } else {
        onNextQuestion();
      }
    } finally {
      setIsProcessingAction(false);
    }
  }, [onNextQuestion, isLastQuestion, saveInterviewOnce, stopSTT, commitCurrentTranscript, isProcessingAction]);

  // ---------- Beep utility ----------
  const beep = useCallback((ms = 300, freq = 880) => {
    try {
      const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      g.gain.setValueAtTime(0.001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
      o.stop(ctx.currentTime + ms / 1000 + 0.02);
    } catch {}
  }, []);

  // ---------- TTS Warmup ----------
  const warmupTTS = useCallback(() => {
    if (ttsWarmedRef.current) return;
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      u.rate = 1;
      u.onend = () => {
        ttsWarmedRef.current = true;
      };
      window.speechSynthesis.speak(u);
    } catch {}
  }, []);

  // ========== New flow for VIDEO mode ==========
  // Immediately enter "interview started" state in video mode and show setup assistant
  useEffect(() => {
    if (interviewMode !== "video") return;
    setHasHRInterviewStarted(true);
    setNeedsSetup(true);
    // prepare hardware, but do not broadcast yet
    startCamera();
    startMic();
    warmupTTS();
    // Do NOT set pendingUtterance here; wait until user confirms in assistant
  }, [interviewMode, startCamera, startMic, warmupTTS]);

  // Called when user presses "Start Interview" inside the assistant
  const handleConfirmSetup = useCallback(() => {
    if (!videoStream) return;
    setNeedsSetup(false);

    // Set question ID for video mode
    currentQuestionIdRef.current = question;
    currentTranscriptionIdRef.current = question;
    
    // Ensure user preference is set to unmuted for video mode (so STT auto-starts after TTS)
    userMicPrefRef.current = true;

    // Now broadcast to the left "Presence" card
    window.__hrVideoStream = videoStream;
    window.dispatchEvent(new CustomEvent("hr-video-stream"));

    // Queue TTS to read the current question
    setPendingUtterance(question);
  }, [videoStream, question]);

  // ---------------- TTS (voices) ----------------
  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  const selectPreferredVoice = useCallback(
    (all: SpeechSynthesisVoice[], gender: VoiceGender): SpeechSynthesisVoice | null => {
      const exactName = gender === "male" ? "Google UK English Male" : "Google UK English Female";
      const byExact = all.find(v => v.name === exactName && v.lang === "en-GB");
      if (byExact) return byExact;

      const googleGB = all.find(v => v.name.toLowerCase().includes("google") && v.lang === "en-GB");
      if (googleGB) return googleGB;

      const anyGB = all.find(v => v.lang === "en-GB");
      if (anyGB) return anyGB;

      const anyEN = all.find(v => v.lang?.toLowerCase().startsWith("en"));
      if (anyEN) return anyEN;

      return all[0] || null;
    },
    []
  );

  useEffect(() => {
    if (!voices.length) return;
    let v = selectPreferredVoice(voices, voiceGender);

    if (voiceGender === "male" && v && /female/i.test(v.name)) {
      const maleFallback =
        voices.find(vv => /male/i.test(vv.name) && vv.lang === "en-GB") ||
        voices.find(vv => /male/i.test(vv.name)) ||
        v;
      v = maleFallback;
    }
    if (voiceGender === "female" && v && /male/i.test(v.name)) {
      const femaleFallback =
        voices.find(vv => /female/i.test(vv.name) && vv.lang === "en-GB") ||
        voices.find(vv => /female/i.test(vv.name)) ||
        v;
      v = femaleFallback;
    }

    setChosenVoice(v || null);
  }, [voices, voiceGender, selectPreferredVoice]);

  useEffect(() => {
    if (voices.length) warmupTTS();
  }, [voices, warmupTTS]);

  const cancelTTS = useCallback(() => {
    try {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      policyPausedRef.current = false;
    } catch {}
  }, []);

  // Helper: start wave only when lottie is ready
  const startWaveIfReady = useCallback(() => {
    const wave = voiceWaveRef.current;
    if (!wave || !lottieReadyRef.current) return false;
    wave.goToAndPlay?.(0, true);
    return true;
  }, []);

  // Helper to restart STT after TTS events
  const restartSTTAfterTTS = useCallback((delay = 500) => {
    if (!userMicPrefRef.current) {
      console.log("[STT Restart Helper] User prefers muted, keeping STT stopped.");
      const t = micTrackRef.current ?? audioStream?.getAudioTracks?.()[0] ?? null;
      if (t) t.enabled = false;
      setIsMicMuted(true);
      return;
    }

    console.log(`[STT Restart Helper] Attempting to auto-start STT after delay (${delay}ms).`);
    setTimeout(() => {
      // Ensure mic is enabled before starting STT
      const t = micTrackRef.current ?? audioStream?.getAudioTracks?.()[0] ?? null;
      if (t) t.enabled = true;
      setIsMicMuted(false);

      // Force reset STT state first to ensure clean start
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
          console.log("[STT Restart Helper] Force stopped existing recognition.");
        } catch (e) {
          console.log("[STT Restart Helper] Force stop failed (may already be stopped):", e);
        }
      }
      
      // Reset state
      setIsSpeechListening(false);
      setInterimTranscript("");
      setFinalTranscript("");
      finalTranscriptRef.current = "";

      // Wait a bit more then start fresh, only if not already listening
      setTimeout(() => {
        if (userMicPrefRef.current && !isSpeechListening) {
          console.log("[STT Restart Helper] Starting fresh STT after reset.");
          startSTT();
        }
      }, 100); // Small internal delay for state propagation
    }, delay);
  }, [audioStream, isSpeechListening, startSTT]);

  const speakQuestion = useCallback((text: string) => {
    if (!text) {
      console.warn("[TTS] speakQuestion: No text provided.");
      return;
    }
    if (!chosenVoice) {
      console.warn("[TTS] speakQuestion: No chosen voice available. Cannot speak. Current voices:", voices);
      return;
    }
    try {
      console.log("[TTS] Attempting to speak question:", text, "with voice:", chosenVoice.name);
      try { (window.speechSynthesis as any)?.resume?.() } catch (e) {
        console.warn("[TTS] Failed to resume speech synthesis (might be paused by policy):", e);
      }

      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.voice = chosenVoice; // chosenVoice is guaranteed by the check above
      u.lang = chosenVoice.lang || "en-GB";

      u.rate = 0.92;
      u.pitch = voiceGender === "male" ? 0.85 : 1.05;
      u.volume = 1.0;

      u.onstart = () => {
        console.log("[TTS] onstart: TTS speaking started.");
        setIsSpeaking(true);
        // TTS starts: stop STT, mute mic, mark auto-muted
        if (isSpeechListening) {
          console.log("[TTS] onstart: STT was listening, stopping it now.");
          stopSTT();
          prevMicEnabledRef.current = micTrackRef.current?.enabled ?? true;
          if (micTrackRef.current) micTrackRef.current.enabled = false;
          setIsMicMuted(true);
          autoMutedForTTSRef.current = true;
        }

        if (!startWaveIfReady()) {
          const t0 = performance.now();
          const tick = () => {
            if (startWaveIfReady()) return;
            if (performance.now() - t0 < 300) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      };
      u.onend = () => {
        console.log("[TTS] onend: TTS speaking finished.");
        setIsSpeaking(false);
        autoMutedForTTSRef.current = false;
        restartSTTAfterTTS(500); // Use helper with consistent delay
      };
      u.onerror = (event) => {
        const errorType = event?.error || 'unknown';
        console.error(`[TTS] onerror: TTS speaking failed. Error type: ${errorType}`, event);
        setIsSpeaking(false);
        autoMutedForTTSRef.current = false;
        restartSTTAfterTTS(300); // Use helper with consistent delay
      };

      ttsUtterRef.current = u;
      window.speechSynthesis.speak(u);
    } catch (e) {
      console.warn("TTS speak failed:", e);
    }
  }, [chosenVoice, voiceGender, startWaveIfReady, isSpeechListening, stopSTT, restartSTTAfterTTS]);

  // speak only when queued AND voice ready (and not frozen)
  useEffect(() => {
    if (!hasHRInterviewStarted || needsSetup) {
      console.log("[TTS Queue] Not speaking: Interview not started or setup needed.");
      return; // wait until setup confirmed
    }
    if (pendingUtterance && chosenVoice && !isFrozen) {
      console.log("[TTS Queue] Speaking pending utterance:", pendingUtterance);
      if (!firstSpeakDoneRef.current) {
        requestAnimationFrame(() => {
          speakQuestion(pendingUtterance);
          firstSpeakDoneRef.current = true;
        });
      } else {
        speakQuestion(pendingUtterance);
      }
      setPendingUtterance(null);
    } else {
      console.log("[TTS Queue] No pending utterance or voice not ready or frozen. Pending:", pendingUtterance, "Voice:", chosenVoice, "Frozen:", isFrozen);
    }
  }, [pendingUtterance, chosenVoice, speakQuestion, hasHRInterviewStarted, isFrozen, needsSetup]);

  // -------------- Mic Lottie follows STT listening state --------------
  useEffect(() => {
    const api = lottieRef.current;
    if (!api) return;
    if (isSpeechListening && !isMicMuted) { // Only play if STT is listening and mic is not manually muted
      api.play?.();
    } else {
      api.pause?.();
      api.goToAndStop?.(0, true); // Ensure it's stopped and at the beginning
    }
  }, [isSpeechListening, isMicMuted]);

  // ---------- Lock wave speed before first paint ----------
  useLayoutEffect(() => {
    const wave = voiceWaveRef.current;
    lottieReadyRef.current = false;
    if (!wave) return;
    wave.setSpeed?.(0.15);
    wave.goToAndStop?.(0, true);
    wave.pause?.();
    requestAnimationFrame(() => { lottieReadyRef.current = true; });
  }, []);

  // Control play/pause WITHOUT touching speed each time
  useEffect(() => {
    const wave = voiceWaveRef.current;
    if (!wave) return;
    if (isSpeaking && !isFrozen) {
      wave.goToAndPlay?.(0, true);
    } else {
      wave.pause?.();
      wave.goToAndStop?.(0, true);
    }
  }, [isSpeaking, isFrozen]);

  // Mic toggle (no permission loss)
  const toggleMic = useCallback(() => {
    const track = micTrackRef.current ?? audioStream?.getAudioTracks()?.[0] ?? null;
    if (!track) return;

    if (isSpeaking) {
      // TTS is speaking - toggle between user's preference
      userMicPrefRef.current = !userMicPrefRef.current;
      console.log("[Mic Toggle] TTS speaking - preference toggled to:", userMicPrefRef.current ? "unmuted" : "muted");
      return;
    }

    // Normal case - toggle STT on/off
    if (isSpeechListening) {
      // Currently listening - stop STT
      console.log("[Mic Toggle] Stopping STT");
      stopSTT();
      if (track) track.enabled = false;
      setIsMicMuted(true);
      userMicPrefRef.current = false; // Update preference to match action
    } else {
      // Currently idle - start STT
      console.log("[Mic Toggle] Starting STT");
      if (track) track.enabled = true;
      setIsMicMuted(false);
      userMicPrefRef.current = true; // Update preference to match action
      startSTT();
    }
  }, [audioStream, isSpeaking, isSpeechListening, startSTT, stopSTT]);

  // ---------- Timers — gated by isFrozen ----------
  useEffect(() => {
    let t: NodeJS.Timeout;
    if (isHRThinking && hasHRInterviewStarted && !hasStartedAnswering && !isFrozen && !needsSetup) {
      t = setInterval(() => {
        setHRThinkTime((prev) => {
          if (prev <= 1) {
            clearInterval(t);
            setIsHRThinking(false);
            setHasStartedAnswering(true);
            console.log("[Timer] Think time expired - starting answer phase");
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(t);
  }, [isHRThinking, hasHRInterviewStarted, hasStartedAnswering, isFrozen, needsSetup]);

  useEffect(() => {
    let t: NodeJS.Timeout;
    if (hasStartedAnswering && hrAnswerTime > 0 && hasHRInterviewStarted && !isFrozen && !needsSetup) {
      t = setInterval(() => setHRAnswerTime((prev) => (prev <= 1 ? 0 : prev - 1)), 1000);
    } else if (hasStartedAnswering && hrAnswerTime === 0 && hasHRInterviewStarted && !isFrozen && !needsSetup) {
      // Timer expired - user was silent, save with null transcription
      console.log("[Timer] Answer time expired - saving with null transcription");
      handleSubmitHRAnswer();
    }
    return () => clearInterval(t);
  }, [hasStartedAnswering, hrAnswerTime, hasHRInterviewStarted, handleSubmitHRAnswer, isFrozen, needsSetup]);

  // ---------- Question change resets timers/text ----------
  useEffect(() => {
    const prevQuestion = questionRef.current;
    questionRef.current = question;
    if (hasHRInterviewStarted && prevQuestion && prevQuestion !== question) {
      console.log("[Question Change] New question detected, resetting state");
      
      // Immediately cancel any ongoing TTS and force reset STT for a clean slate
      cancelTTS();
      console.log("[Question Change] Force resetting STT for new question");
      forceResetSTT();
      
      // Reset UI for fresh box - completely isolate from previous question
      finalTranscriptRef.current = "";
      setInterimTranscript("");
      setFinalTranscript("");
      setHRAnswerText("");
      setIsHRThinking(true);
      setHasStartedAnswering(false);
      setHRThinkTime(15);
      setHRAnswerTime(60);

      // Set question ID for new question (use question text as ID)
      currentQuestionIdRef.current = question;
      currentTranscriptionIdRef.current = question;

      // Read the question: mutes mic + pauses STT in onstart; onend restores per preference
      if (!isFrozen && !needsSetup) {
        setPendingUtterance(question);
      }
    }
  }, [question, hasHRInterviewStarted, isFrozen, needsSetup, forceResetSTT, cancelTTS]);

  // ---------- Policy events from detector (multi-person) ----------
  const handlePolicyEvent = useCallback((e: { type: "multi-person-detected" }) => {
    if (e.type !== "multi-person-detected") return;

    try {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        policyPausedRef.current = true;
        setIsSpeaking(false);
      }
    } catch {}

    beep();
    setFreezeSecondsLeft(3);
    setIsFrozen(true);

    const interval = setInterval(() => {
      setFreezeSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);

    setTimeout(() => {
      clearInterval(interval);
      setIsFrozen(false);
      try {
        if (policyPausedRef.current && (window.speechSynthesis as any).paused) {
          (window.speechSynthesis as any).resume();
        }
      } catch {}
      policyPausedRef.current = false;
    }, 3000);
  }, [beep]);

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
      <div className="h-[14vh] flex flex-col">
        {speechSupported && (
          <div className="flex items-center gap-2 text-sm mb-2">
            <StatusBadge isListening={isSpeechListening} />
            <div className="ml-auto text-xs opacity-70">
              lang: <code>en-IN</code> • continuous • interim
            </div>
          </div>
        )}
        <Textarea
          readOnly
          value={(finalTranscript + " " + interimTranscript).trim()}
          placeholder="Speak into the microphone… live transcription will appear here."
          className="flex-1 min-h-0 resize-none"
          disabled={isFrozen || !speechSupported}
        />
        {speechError && <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 p-2 rounded-md">{speechError}</div>}
      </div>
    );

    const showSetup = hasHRInterviewStarted && interviewMode === "video" && videoStream && needsSetup;
 
  // track alignment status from assistant
  const [isSetupAligned, setIsSetupAligned] = useState(false);

  return (
    <Card className="h-full max-h-full grid grid-rows-[auto,1fr,auto] overflow-hidden shadow-lg">
      <CardHeader className="pt-3 pb-0 min-h-0">
        <div className="flex justify-between items-center mb-2">
          <CardTitle className="text-xl font-bold text-gray-800">Interview Question</CardTitle>

          {/* Voice gender selection only before session (text mode) */}
          {!hasHRInterviewStarted && interviewMode === "text" && (
            <div className="flex items-center gap-2 text-sm">
              <span className="mr-1 text-gray-600 flex items-center gap-1">
                HR Voice
                <Info className="h-4 w-4 text-gray-400" />
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

        {/* Setup CTA placed in white space below video when setup is active */}
        {showSetup && (
          <div className="mt-2 mb-1 flex justify-center">
            <Button
              onClick={handleConfirmSetup}
              disabled={!isSetupAligned}
              className={cn("px-4", !isSetupAligned ? "opacity-60 cursor-not-allowed" : "")}
              title={isSetupAligned ? "Start the interview" : "Align face and lighting first"}
            >
              Start Interview
            </Button>
          </div>
        )}

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
                setHasHRInterviewStarted(true);
                // Set question ID for text mode
                currentQuestionIdRef.current = question;
                currentTranscriptionIdRef.current = question;
                // Ensure user preference is set to unmuted for text mode (so STT auto-starts after TTS)
                userMicPrefRef.current = true;
                setPendingUtterance(question);
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
            <div className="mt-3 rounded-xl bg-gray-50 border">
              {/* Keep height in a wrapper so the button can sit outside within white space */}
              <div className="relative h-[48vh] min-h-0">
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
                      onStatus={(ok) => setIsSetupAligned(!!ok)}
                      showConfirmButton={false}
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
                        variant={isSpeechListening ? "default" : "outline"}
                        className={cn(
                          "h-6 px-2 py-0 text-[11px] mb-1",
                          isSpeechListening ? "bg-blue-600 hover:bg-blue-700" : "border-gray-300 text-gray-700"
                        )}
                        title={isSpeechListening ? "Mute mic" : "Turn mic on"}
                        disabled={isFrozen}
                      >
                        {isSpeechListening ? <><Mic className="h-3 w-3 mr-1" /> Mute</> : <><MicOff className="h-3 w-3 mr-1" /> Unmute</>}
                      </Button>

                      <div className="relative w-24 aspect-square rounded-lg overflow-hidden bg-white border shadow-sm">
                        <Lottie
                          ref={lottieRef}
                          animationData={micEnabledAnim}
                          loop
                          play={isSpeechListening && !isMicMuted} // Control play based on STT listening and mic mute state
                          style={{ width: "100%", height: "100%" }}
                        />
                        {!isSpeechListening && (
                          <div className="absolute inset-0 flex items-center justify-center bg-white/70">
                            <MicOff className="h-7 w-7 text-gray-500" />
                          </div>
                        )}
                      </div>
                      <div className="mt-1 text-[10px] text-gray-600">
                        {isSpeechListening ? "Listening…" : "Idle"}
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
              {/* Only show "Skip Question" if not the last question */}
              {!isLastQuestion && (
                <Button
                  variant="outline"
                  onClick={async () => {
                    if (isProcessingAction) return; // Prevent multiple clicks
                    setIsProcessingAction(true);
                    console.log("[UI Action] Skip Question clicked.");
                    try {
                      stopSTT(); // Stop STT immediately
                      commitCurrentTranscript(); // Commit current answer
                      onNextQuestion(); // Move to next question
                    } finally {
                      setIsProcessingAction(false);
                    }
                  }}
                  title="Skip to the next question"
                  disabled={isFrozen || isProcessingAction || isSpeaking}
                >
                  <SkipForward className="h-4 w-4 mr-2" />
                  Skip Question
                </Button>
              )}

              {/* "Submit Answer" or "Finish Interview" button */}
              <Button onClick={handleSubmitHRAnswer} title={isLastQuestion ? "Finish the interview" : "Submit your answer"} disabled={isFrozen || isProcessingAction || isSpeaking}>
                {isProcessingAction ? (
                  <span className="flex items-center">
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    {isLastQuestion ? "Finishing..." : "Submitting..."}
                  </span>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-2" />
                    {isLastQuestion ? "Finish Interview" : "Submit Answer"}
                  </>
                )}
              </Button>
            </div>
          </CardFooter>
        </>
      )}
    </Card>
  )
}

function StatusBadge({ isListening }: { isListening: boolean }) {
  return (
    <div className="inline-flex items-center gap-2 text-sm bg-gray-100 text-gray-900 rounded-full px-2 py-1">
      <span
        className={cn(
          "w-2.5 h-2.5 rounded-full inline-block",
          isListening ? "bg-green-500 shadow-green-500/30 shadow-lg" : "bg-gray-400"
        )}
      />
      <span className="font-semibold">
        {isListening ? "Listening…" : "Idle"}
      </span>
    </div>
  );
}
