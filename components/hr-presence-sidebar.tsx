import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Info, MessageSquare, Video } from "lucide-react"
import { useEffect, useRef, useState } from "react"

interface HRPresenceSidebarProps {
  interviewMode: "text" | "video"
  currentQuestionIndex: number
  totalQuestions: number
}

export function HRPresenceSidebar({
  interviewMode,
  currentQuestionIndex,
  totalQuestions,
}: HRPresenceSidebarProps) {
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const [hasStream, setHasStream] = useState(false)
  const VIDEO_ID = "hrPresenceVideo"

  useEffect(() => {
    const attach = () => {
      const el = document.getElementById(VIDEO_ID) as HTMLVideoElement | null
      videoElRef.current = el
      if (!el) return
      const stream = (window as any).__hrVideoStream as MediaStream | null | undefined
      if (stream && el.srcObject !== stream) {
        el.srcObject = stream
        el.play?.().catch(() => {})
        setHasStream(true)
      } else if (!stream) {
        setHasStream(false)
      }
    }
    attach()
    window.addEventListener("hr-video-stream", attach)
    return () => {
      window.removeEventListener("hr-video-stream", attach)
      // IMPORTANT: don't clear el.srcObject here—panel controls lifecycle.
    }
  }, [])

  const getModeIcon = () =>
    interviewMode === "video" ? <Video className="h-5 w-5 text-green-600" /> : <MessageSquare className="h-5 w-5 text-blue-600" />
  const getModeColor = () => (interviewMode === "video" ? "text-green-600" : "text-blue-600")

  return (
    <div className="space-y-6">
      <Card className="shadow-lg">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-lg font-semibold text-gray-800">Your Presence</CardTitle>
          <Info className="h-4 w-4 text-gray-400" />
        </CardHeader>
        <CardContent className="space-y-4">
          {interviewMode === "video" ? (
            <div className="relative w-full h-48 bg-gray-100 rounded-lg overflow-hidden">
              <video
                id={VIDEO_ID}
                autoPlay
                playsInline
                muted
                className="absolute inset-0 w-full h-full object-cover"
              />
              {!hasStream && (
                <div className="absolute inset-0 flex items-center justify-center text-gray-500 pointer-events-none">
                  <div className="text-center">
                    <Video className="h-5 w-5 text-green-600 mx-auto" />
                    <p className="mt-2 font-medium">Video Mode</p>
                    <p className="text-sm">Camera Feed</p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="relative w-full h-48 bg-gray-100 rounded-lg overflow-hidden flex items-center justify-center">
              <div className="text-gray-500 text-center">
                {getModeIcon()}
                <p className="mt-2 font-medium">Text Mode</p>
                <p className="text-sm">Type your responses</p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 text-center text-sm">
            <div className="p-2 bg-gray-100 rounded-md">
              <p className="font-medium text-gray-700">Mode</p>
              <p className={getModeColor()}>
                <span className="capitalize">{interviewMode}</span>
              </p>
            </div>
            <div className="p-2 bg-gray-100 rounded-md">
              <p className="font-medium text-gray-700">Status</p>
              <p className="text-green-600">Active</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-lg">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg font-semibold text-gray-800">Interview Progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between text-sm text-gray-700">
            <span>Questions Completed</span>
            <span>
              {currentQuestionIndex}/{totalQuestions}
            </span>
          </div>
          <Progress value={(currentQuestionIndex / totalQuestions) * 100} className="h-2" />
          <Separator />
          <div className="space-y-2 text-sm text-gray-600">
            <p className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-green-500"></span> Work under pressure
            </p>
            <p className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-blue-500"></span> Team collaboration
            </p>
            <p className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-purple-500"></span> Handling feedback
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
