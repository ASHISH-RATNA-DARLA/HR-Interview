"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ShieldCheck, Smile, Mic, HardDrive } from "lucide-react"

interface HRConsentModalProps {
  onConsentAccepted: (camera: boolean, mic: boolean, textOnly: boolean) => void
}

export function HRConsentModal({ onConsentAccepted }: HRConsentModalProps) {
  const [isOpen, setIsOpen] = useState(true)
  const [cameraChecked, setCameraChecked] = useState(true)
  const [micChecked, setMicChecked] = useState(true)

  const handleHRConsentAccept = () => {
    setIsOpen(false)
    onConsentAccepted(cameraChecked, micChecked, false)
  }

  const handleHRTextOnlyMode = () => {
    setIsOpen(false)
    onConsentAccepted(false, false, true)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="sm:max-w-[480px] p-6">
        <DialogHeader className="text-center">
          <ShieldCheck className="mx-auto h-16 w-16 text-blue-600 mb-4" />
          <DialogTitle className="text-2xl font-bold text-gray-800">Camera & Microphone Access</DialogTitle>
          <DialogDescription className="text-gray-600 mt-2">
            We analyze facial expressions and voice patterns to provide behavioral insights. Your privacy is our
            priority.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="flex items-start space-x-4 p-4 bg-blue-50 rounded-lg">
            <Smile className="h-6 w-6 text-blue-600 mt-1" />
            <div>
              <h3 className="font-semibold text-gray-800">Facial Expression Analysis</h3>
              <p className="text-sm text-gray-600">Detects confidence, engagement, and emotional responses</p>
            </div>
          </div>
          <div className="flex items-start space-x-4 p-4 bg-green-50 rounded-lg">
            <Mic className="h-6 w-6 text-green-600 mt-1" />
            <div>
              <h3 className="font-semibold text-gray-800">Voice Pattern Recognition</h3>
              <p className="text-sm text-gray-600">Analyzes speech pace, tone, and clarity</p>
            </div>
          </div>
          <div className="flex items-start space-x-4 p-4 bg-purple-50 rounded-lg">
            <HardDrive className="h-6 w-6 text-purple-600 mt-1" />
            <div>
              <h3 className="font-semibold text-gray-800">Local Processing</h3>
              <p className="text-sm text-gray-600">All analysis happens on your device - no data sent to servers</p>
            </div>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 mt-4">
          <Button variant="outline" className="flex-1 py-3 bg-transparent" onClick={handleHRTextOnlyMode}>
            Text Only Mode
          </Button>
          <Button className="flex-1 py-3" onClick={handleHRConsentAccept}>
            I Understand & Accept
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
