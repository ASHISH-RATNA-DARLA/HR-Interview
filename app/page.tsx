"use client"

import { useState, useCallback, useEffect } from "react"
import { HRResumeUpload } from "@/components/hr-resume-upload"
import { HRModeSelection } from "@/components/hr-mode-selection"
import { HRInterviewPanel } from "@/components/hr-interview-panel"
import { HRPresenceSidebar } from "@/components/hr-presence-sidebar"
import { HRInterviewReport } from "@/components/hr-interview-report" // New import
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

type HRInterviewStage = "upload" | "mode-selection" | "interview" | "report"
type InterviewMode = "text" | "video"

interface HRResumeData {
  summary: string
  skills: string[]
  experience: string[]
}

export default function HRInterviewSimulatorPage() {
  const [hrInterviewStage, setHRInterviewStage] = useState<HRInterviewStage>("upload")
  const [hrResumeData, setHRResumeData] = useState<HRResumeData | null>({
    summary: "Experienced software engineer with a focus on AI/ML and full-stack development.",
    skills: ["React", "Next.js", "Python", "TensorFlow", "Kubernetes"],
    experience: ["Developed scalable AI models", "Led front-end team"],
  })
  const [hrInterviewQuestions, setHRInterviewQuestions] = useState<string[]>([
    "Tell me about a time you had to optimize performance. What were the results?",
    "Describe a challenging project where you had to use your React skills.",
    "How do you approach debugging complex Python applications?",
    "What's your experience with deploying applications to Kubernetes?",
    "How do you stay updated with the latest AI/ML trends?",
    "Tell me about a time you received constructive feedback and how you applied it.",
    "What are your long-term career goals?",
    "Do you have any questions for me?",
  ])
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0)
  const [interviewMode, setInterviewMode] = useState<InterviewMode>("text")

  const handleHRResumeUpload = async (file: File) => {
    setHRInterviewStage("mode-selection")
  }

  const handleModeSelection = (mode: InterviewMode) => {
    setInterviewMode(mode)
    setHRInterviewStage("interview")
  }

  const handleHRNextQuestion = () => {
    if (currentQuestionIndex < hrInterviewQuestions.length - 1) {
      setCurrentQuestionIndex((i) => i + 1)
    } else {
      setHRInterviewStage("report")
    }
  }

  const handleStartNewInterview = () => {
    setHRResumeData({
      summary: "Experienced software engineer with a focus on AI/ML and full-stack development.",
      skills: ["React", "Next.js", "Python", "TensorFlow", "Kubernetes"],
      experience: ["Developed scalable AI models", "Led front-end team"],
    })
    setHRInterviewQuestions([
      "Tell me about a time you had to optimize performance. What were the results?",
      "Describe a challenging project where you had to use your React skills.",
      "How do you approach debugging complex Python applications?",
      "What's your experience with deploying applications to Kubernetes?",
      "How do you stay updated with the latest AI/ML trends?",
      "Tell me about a time you received constructive feedback and how you applied it.",
      "What are your long-term career goals?",
      "Do you have any questions for me?",
    ])
    setCurrentQuestionIndex(0)
    setInterviewMode("text")
    setHRInterviewStage("upload")
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <main className="flex-1 p-6 container mx-auto">
        {hrInterviewStage === "upload" && (
          <div className="flex items-center justify-center min-h-[calc(100vh-120px)]">
            <HRResumeUpload onFileUpload={handleHRResumeUpload} />
          </div>
        )}

        {hrInterviewStage === "mode-selection" && <HRModeSelection onModeSelected={handleModeSelection} />}

        {hrInterviewStage === "interview" && hrInterviewQuestions.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full">
            <div className="lg:col-span-1">
              <HRPresenceSidebar
                interviewMode={interviewMode}
                currentQuestionIndex={currentQuestionIndex}
                totalQuestions={hrInterviewQuestions.length}
              />
            </div>
            <div className="lg:col-span-2">
              <HRInterviewPanel
                question={hrInterviewQuestions[currentQuestionIndex]}
                onNextQuestion={handleHRNextQuestion}
                isLastQuestion={currentQuestionIndex === hrInterviewQuestions.length - 1}
                interviewMode={interviewMode}
              />
            </div>
          </div>
        )}

        {hrInterviewStage === "report" && (
          <div className="flex items-center justify-center min-h-[calc(100vh-120px)]">
            <HRInterviewReport onStartNewInterview={handleStartNewInterview} />
          </div>
        )}
      </main>
    </div>
  )
}
