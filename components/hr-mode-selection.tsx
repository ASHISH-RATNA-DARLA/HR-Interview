"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Card, CardContent } from "@/components/ui/card"
import { MessageSquare, Video, ShieldCheck } from "lucide-react"

interface HRModeSelectionProps {
  onModeSelected: (mode: "text" | "video") => void
}

export function HRModeSelection({ onModeSelected }: HRModeSelectionProps) {
  const [isOpen, setIsOpen] = useState(true)

  const handleModeSelect = (mode: "text" | "video") => {
    setIsOpen(false)
    onModeSelected(mode)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="sm:max-w-[600px] p-6">
        <DialogHeader className="text-center">
          <ShieldCheck className="mx-auto h-16 w-16 text-blue-600 mb-4" />
          <DialogTitle className="text-2xl font-bold text-gray-800">Choose Your Interview Mode</DialogTitle>
          <DialogDescription className="text-gray-600 mt-2">
            Select how you'd like to participate in the interview simulation
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-6">
          <Card
            className="cursor-pointer hover:shadow-md transition-shadow border-2 hover:border-blue-300"
            onClick={() => handleModeSelect("text")}
          >
            <CardContent className="flex items-center space-x-4 p-6">
              <MessageSquare className="h-12 w-12 text-blue-600" />
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-gray-800">Text Only Mode</h3>
                <p className="text-sm text-gray-600">
                  Type your answers using the keyboard. Perfect for those who prefer written responses.
                </p>
                <div className="mt-2 text-xs text-green-600 font-medium">✓ No camera or microphone required</div>
              </div>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:shadow-md transition-shadow border-2 hover:border-blue-300"
            onClick={() => handleModeSelect("video")}
          >
            <CardContent className="flex items-center space-x-4 p-6">
              <Video className="h-12 w-12 text-green-600" />
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-gray-800">Video Interview Mode</h3>
                <p className="text-sm text-gray-600">
                  Full video interview with camera and microphone. Includes voice recording and behavioral analysis.
                </p>
                <div className="mt-2 text-xs text-blue-600 font-medium">
                  ✓ Camera + Microphone + Voice Recording + Behavioral insights
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </DialogContent>
    </Dialog>
  )
}
