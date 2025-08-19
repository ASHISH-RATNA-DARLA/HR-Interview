// pages/speech-test.js
import { useEffect, useRef, useState } from "react";

export default function SpeechTestPage() {
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState(null);
  const [isListening, setIsListening] = useState(false);
  const [finalTranscript, setFinalTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const recognitionRef = useRef(null);
  const shouldAutoRestartRef = useRef(false);
  const finalTranscriptRef = useRef("");

  // Detect support on client
  useEffect(() => {
    if (typeof window === "undefined") return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    setSupported(!!SR);
  }, []);

  // Init recognition once on client
  useEffect(() => {
    if (!supported || typeof window === "undefined") return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new SR();

    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-IN";

    r.onstart = () => {
      setIsListening(true);
      setError(null);
    };

    r.onerror = (e) => {
      // Common errors: "no-speech", "audio-capture", "not-allowed"
      setError(e?.error ? `Recognition error: ${e.error}` : "Unknown recognition error");
    };

    r.onend = () => {
      setIsListening(false);
      // Chrome sometimes ends unexpectedly even with continuous=true; restart if user didn't press Stop.
      if (shouldAutoRestartRef.current) {
        try {
          r.start();
        } catch (err) {
          // Swallow "start" errors (usually because it's already starting) and surface user-friendly note
          setError((prev) => prev ?? "Attempting to keep listening…");
        }
      }
    };

    r.onresult = (event) => {
      let interim = "";
      // Append results since last index
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
  }, [supported]);

  const startListening = () => {
    if (!supported || !recognitionRef.current) return;
    if (isListening) return;
    setError(null);
    shouldAutoRestartRef.current = true;
    try {
      recognitionRef.current.start();
    } catch (err) {
      setError("Could not start recognition. Try clicking Stop, then Start again.");
    }
  };

  const stopListening = () => {
    if (!recognitionRef.current) return;
    shouldAutoRestartRef.current = false;
    try {
      recognitionRef.current.stop();
    } catch {}
  };

  const clearTranscript = () => {
    finalTranscriptRef.current = "";
    setFinalTranscript("");
    setInterimTranscript("");
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Speech-to-Text Test (Web Speech API)</h1>

        {!supported ? (
          <div style={styles.unsupported}>
            <strong>SpeechRecognition not supported.</strong>
            <div style={{ marginTop: 8 }}>
              Try Chrome or Edge on desktop. Safari/Firefox may not support it.
            </div>
          </div>
        ) : (
          <>
            <div style={styles.statusRow}>
              <StatusBadge isListening={isListening} />
              <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.7 }}>
                lang: <code>en-IN</code> • continuous • interim
              </div>
            </div>

            <textarea
              readOnly
              value={(finalTranscript + " " + interimTranscript).trim()}
              placeholder="Start speaking… live transcription will appear here."
              style={styles.textarea}
            />

            {error && <div style={styles.error}>{error}</div>}

            <div style={styles.controls}>
              <button
                onClick={startListening}
                disabled={isListening}
                style={{ ...styles.btn, ...(isListening ? styles.btnDisabled : styles.btnPrimary) }}
              >
                Start
              </button>
              <button
                onClick={stopListening}
                disabled={!isListening}
                style={{ ...styles.btn, ...(!isListening ? styles.btnDisabled : styles.btnStop) }}
              >
                Stop
              </button>
              <button onClick={clearTranscript} style={{ ...styles.btn, ...styles.btnGhost }}>
                Clear
              </button>
            </div>

            <p style={styles.hint}>
              Tip: Speak naturally. You’ll see interim (grey) text while you talk; once the API
              finalizes a phrase, it’s appended to the transcript.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ isListening }) {
  return (
    <div style={styles.status}>
      <span
        style={{
          ...styles.dot,
          background: isListening ? "#22c55e" : "#9ca3af",
          boxShadow: isListening ? "0 0 0 6px rgba(34,197,94,0.15)" : "none",
        }}
      />
      <span style={{ fontWeight: 600 }}>
        {isListening ? "Listening…" : "Idle"}
      </span>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--background, #0b1020)",
    padding: 24,
  },
  card: {
    width: "min(900px, 95vw)",
    background: "white",
    color: "#0f172a",
    borderRadius: 16,
    padding: 20,
    boxShadow:
      "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
  },
  title: { margin: 0, fontSize: 20, fontWeight: 800 },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginTop: 16,
    marginBottom: 8,
  },
  status: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    fontSize: 14,
    background: "#f1f5f9",
    color: "#0f172a",
    borderRadius: 999,
    padding: "6px 10px",
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    display: "inline-block",
  },
  textarea: {
    width: "100%",
    minHeight: 220,
    resize: "vertical",
    marginTop: 8,
    padding: 12,
    borderRadius: 12,
    border: "1px solid #e5e7eb",
    outline: "none",
    lineHeight: 1.5,
    fontSize: 15,
    background: "#f8fafc",
    color: "#0f172a",
  },
  controls: {
    display: "flex",
    gap: 10,
    marginTop: 12,
  },
  btn: {
    borderRadius: 10,
    padding: "10px 14px",
    fontWeight: 700,
    border: "1px solid transparent",
    cursor: "pointer",
  },
  btnPrimary: {
    background: "#2563eb",
    color: "white",
  },
  btnStop: {
    background: "#ef4444",
    color: "white",
  },
  btnGhost: {
    background: "white",
    border: "1px solid #e5e7eb",
    color: "#0f172a",
  },
  btnDisabled: {
    opacity: 0.5,
    cursor: "not-allowed",
  },
  error: {
    marginTop: 10,
    background: "#fef2f2",
    color: "#7f1d1d",
    border: "1px solid #fecaca",
    padding: 10,
    borderRadius: 8,
    fontSize: 14,
  },
  unsupported: {
    marginTop: 12,
    background: "#fff7ed",
    color: "#7c2d12",
    border: "1px solid #fed7aa",
    padding: 12,
    borderRadius: 8,
    fontSize: 14,
  },
  hint: { marginTop: 12, fontSize: 12, opacity: 0.7 },
};
