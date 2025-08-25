"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useEffect, useState, useMemo } from "react"
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend,
  AreaChart, Area, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, ScatterChart,
  Scatter, Cell, PieChart, Pie
} from "recharts"

interface HRInterviewReportProps {
  onStartNewInterview: () => void
}

interface SessionMetrics {
  eyeContactFrames: number[]
  eyeContactPercent: number[]
  offscreenFrames: number[]
  offscreenSeconds: number[]
  blinkCount: number[]
  blinkRatePerMin: number[]
  multiPersonWarnings: number
  nodCount: number
  shakeCount: number
  emotionsRaw: { [key: string]: number }[]
  emotionsAvg5: { [key: string]: number }[]
  topEmotionTrends: { emotion: string; count: number }[]
  handActivity: { oneHand: number; twoHands: number; none: number }[]
  postureHint: string[]
  yaw: number[]
  pitch: number[]
  roll: number[]
  objectLabelCounts: { [key: string]: number }[]
}

export function HRInterviewReport({ onStartNewInterview }: HRInterviewReportProps) {
  const [sessionMetrics, setSessionMetrics] = useState<SessionMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Helper calculation functions (moved to top for initialization)
    const calculateStability = (yaw: number[], pitch: number[], roll: number[]): number => {
      const movements = yaw.map((y, i) => Math.abs(y) + Math.abs(pitch[i] || 0) + Math.abs(roll[i] || 0))
      const avgMovement = movements.reduce((sum, val) => sum + val, 0) / movements.length
      return Math.max(0, Math.min(100, 100 - (avgMovement * 200))) // Scale and invert, reduced penalty
    }

  const calculateAttentionSpan = (offscreenFrames: number[]): number => {
    const onscreenFrames = offscreenFrames.filter(frame => frame === 0).length
    return Math.round((onscreenFrames / offscreenFrames.length) * 100)
  }

  const calculateEmotionalVariability = (emotions: { [key: string]: number }[]): number => {
    const neutralScores = emotions.map(e => e.neutral || 0)
    const variance = neutralScores.reduce((acc, score, i, arr) => {
      const mean = arr.reduce((sum, val) => sum + val, 0) / arr.length
      return acc + Math.pow(score - mean, 2)
    }, 0) / neutralScores.length
    return Math.min(100, variance * 1000) // Scale variance
  }

  const combineProfessionalMetrics = (metrics: SessionMetrics): number => {
    const goodPosture = metrics.postureHint.filter(p => p !== 'far').length
    const postureScore = (goodPosture / metrics.postureHint.length) * 100
    const avgEyeContact = metrics.eyeContactPercent.reduce((sum, val) => sum + val, 0) / metrics.eyeContactPercent.length
    
    // Penalty for multiple person warnings
    const multiPersonPenalty = metrics.multiPersonWarnings > 0 ? Math.min(30, metrics.multiPersonWarnings * 5) : 0; // Max 30 point penalty
    
    const baseScore = (postureScore + avgEyeContact) / 2;
    return Math.round(Math.max(0, baseScore - multiPersonPenalty));
  }

  const calculateConfidenceLevel = (metrics: SessionMetrics): number => {
    const stability = calculateStability(metrics.yaw, metrics.pitch, metrics.roll)
    const eyeContact = metrics.eyeContactPercent.reduce((sum, val) => sum + val, 0) / metrics.eyeContactPercent.length
    const emotionalStability = 100 - calculateEmotionalVariability(metrics.emotionsAvg5)
    
    // Incorporate nod and shake counts
    const totalFrames = metrics.yaw.length;
    const nodRatio = totalFrames > 0 ? metrics.nodCount / totalFrames : 0;
    const shakeRatio = totalFrames > 0 ? metrics.shakeCount / totalFrames : 0;

    // Positive impact for nodding, slight negative for excessive shaking
    const nodImpact = nodRatio * 50; // Scale to have a meaningful impact
    const shakeImpact = shakeRatio * -20; // Slight penalty for shaking

    let confidence = (stability + eyeContact + emotionalStability) / 3;
    confidence = confidence + nodImpact + shakeImpact;

    return Math.round(Math.max(0, Math.min(100, confidence)));
  }

  const calculateTechQuality = (metrics: SessionMetrics): number => {
    const onscreenPercentage = calculateAttentionSpan(metrics.offscreenFrames)
    const consistentDetection = metrics.eyeContactFrames.length > 0 ? 85 : 60 // Simplified tech quality
    return Math.round((onscreenPercentage + consistentDetection) / 2)
  }

  const calculateStressIndex = (blinks: number, handActivity: any, headMovement: number): number => {
    return Math.min(100, (blinks * 10) + (handActivity.twoHands * 20) + (headMovement * 50))
  }

  const calculateEngagementScore = (eyeContact: number, posture: string, offscreen: number): number => {
    let score = eyeContact
    if (posture === 'far') score -= 20
    if (offscreen > 0) score -= 30
    return Math.max(0, Math.min(100, score))
  }

  const getInterviewPhase = (frameIndex: number, totalFrames: number): string => {
    const ratio = frameIndex / totalFrames
    if (ratio < 0.2) return 'Introduction'
    if (ratio < 0.7) return 'Main Discussion'
    if (ratio < 0.9) return 'Technical/Behavioral'
    return 'Closing'
  }

  const getInsightMessage = (metrics: any): { type: string; message: string }[] => {
    const insights = []
    
    if (metrics.avgEyeContact < 30) {
      insights.push({ type: 'warning', message: '🔴 Low eye contact suggests discomfort with video interviews' })
    }
    
    if (metrics.overallScore > 75) {
      insights.push({ type: 'success', message: '✅ Strong overall interview performance detected' })
    }
    
    if (metrics.emotionalRange > 50) {
      insights.push({ type: 'info', message: '📊 High emotional variability - candidate may be passionate or nervous' })
    }
    
    if (metrics.attentionSpan < 70) {
      insights.push({ type: 'warning', message: '📱 Frequent distractions detected - coaching needed' })
    }

    if (metrics.confidenceLevel > 70) {
      insights.push({ type: 'success', message: '💪 High confidence level demonstrated throughout interview' })
    }

    return insights
  }

  // Enhanced metrics calculations
  const processedMetrics = useMemo(() => {
    if (!sessionMetrics) return null

    // Basic data processing (preserving existing logic)
    const engagementData = sessionMetrics.eyeContactPercent.map((percent, index) => ({
      frame: index,
      "Eye Contact %": percent,
    }))

    const emotionData = sessionMetrics.emotionsAvg5.map((emotionScores, index) => ({
      frame: index,
      ...emotionScores,
    }))

    const postureData = sessionMetrics.postureHint.map((hint, index) => ({
      frame: index,
      posture: hint,
      count: 1,
    }))

    const handActivityData = sessionMetrics.handActivity.map((activity, index) => ({
      frame: index,
      "One Hand": activity.oneHand,
      "Two Hands": activity.twoHands,
      "None": activity.none,
    }))

    // Enhanced calculations
    const stabilityScore = calculateStability(sessionMetrics.yaw, sessionMetrics.pitch, sessionMetrics.roll)
    const attentionSpan = calculateAttentionSpan(sessionMetrics.offscreenFrames)
    const emotionalRange = calculateEmotionalVariability(sessionMetrics.emotionsAvg5)
    const professionalismScore = combineProfessionalMetrics(sessionMetrics)

    // Executive summary metrics
    const avgEyeContact = sessionMetrics.eyeContactPercent.length > 0
      ? sessionMetrics.eyeContactPercent.reduce((sum, val) => sum + val, 0) / sessionMetrics.eyeContactPercent.length
      : 0

    const overallScore = Math.round((avgEyeContact + stabilityScore + attentionSpan + professionalismScore) / 4)
    const confidenceLevel = calculateConfidenceLevel(sessionMetrics)
    const techQuality = calculateTechQuality(sessionMetrics)

    // Stress pattern analysis
    const stressData = sessionMetrics.blinkCount.map((blinks, index) => ({
      frame: index,
      stress: calculateStressIndex(
        blinks,
        sessionMetrics.handActivity[index] || { oneHand: 0, twoHands: 0, none: 1 },
        Math.abs(sessionMetrics.yaw[index] || 0) + Math.abs(sessionMetrics.pitch[index] || 0)
      ),
      blinks,
      handMovement: (sessionMetrics.handActivity[index]?.oneHand || 0) + (sessionMetrics.handActivity[index]?.twoHands || 0),
    }))

    // Engagement timeline with phases
    const engagementTimeline = sessionMetrics.eyeContactPercent.map((contact, index) => ({
      frame: index,
      engagement: calculateEngagementScore(
        contact,
        sessionMetrics.postureHint[index],
        sessionMetrics.offscreenFrames[index]
      ),
      phase: getInterviewPhase(index, sessionMetrics.eyeContactPercent.length),
    }))

    // Radar chart data for professional assessment
    const radarData = [
      { metric: 'Eye Contact', value: Math.min(avgEyeContact, 100), benchmark: 75 },
      { metric: 'Stability', value: stabilityScore, benchmark: 80 },
      { metric: 'Attention', value: attentionSpan, benchmark: 85 },
      { metric: 'Emotional Control', value: 100 - emotionalRange, benchmark: 70 },
      { metric: 'Professionalism', value: professionalismScore, benchmark: 75 },
      { metric: 'Technical Setup', value: techQuality, benchmark: 80 },
    ]

    // Posture distribution
    const postureDistribution = sessionMetrics.postureHint.reduce((acc, posture) => {
      acc[posture] = (acc[posture] || 0) + 1
      return acc
    }, {} as { [key: string]: number })

    const postureChartData = Object.entries(postureDistribution).map(([posture, count]) => ({
      name: posture,
      value: count,
      percentage: Math.round((count / sessionMetrics.postureHint.length) * 100)
    }))

    return {
      engagementData,
      emotionData,
      postureData,
      handActivityData,
      stressData,
      engagementTimeline,
      radarData,
      postureChartData,
      overallScore,
      confidenceLevel,
      techQuality,
      avgEyeContact,
      stabilityScore,
      attentionSpan,
      emotionalRange,
      professionalismScore
    }
  }, [sessionMetrics])

  // Preserve existing useEffect logic
  useEffect(() => {
    const fetchLatestReport = async () => {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch("/api/save-metrics");
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[HRInterviewReport] List API error: ${response.status} ${response.statusText}`, errorText);
          throw new Error(`List error: ${response.status} - ${errorText}`);
        }

        const json = await response.json();
        const files: string[] = Array.isArray(json?.files) ? json.files : [];

        if (!files.includes("report.json")) {
          console.warn("[HRInterviewReport] report.json not found in API response files:", files);
          setError("No report found. Please complete an interview first.");
          return;
        }

        const reportResponse = await fetch("/reports/report.json");
        if (!reportResponse.ok) {
          const errorText = await reportResponse.text();
          console.error(`[HRInterviewReport] Report file read error: ${reportResponse.status} ${reportResponse.statusText}`, errorText);
          throw new Error(`Read error: ${reportResponse.status} - ${errorText}`);
        }

        const rawMetrics: any = await reportResponse.json();
        console.log("[HRInterviewReport] Successfully loaded report.json");

        // Transform rawMetrics to match SessionMetrics interface (preserving existing logic)
        const transformedMetrics: SessionMetrics = {
          eyeContactFrames: rawMetrics.framesLog?.map((frame: any) => frame.eyeContact ? 1 : 0) || [],
          eyeContactPercent: rawMetrics.framesLog?.map((frame: any) => frame.eyeContact ? 100 : 0) || [],
          offscreenFrames: rawMetrics.framesLog?.map((frame: any) => frame.faceCount === 0 ? 1 : 0) || [],
          emotionsRaw: rawMetrics.framesLog?.map((frame: any) => frame.emotionsRaw || {}) || [],
          emotionsAvg5: rawMetrics.framesLog?.map((frame: any) => frame.emotionsAvg5 || {}) || [],
          handActivity: rawMetrics.framesLog?.map((frame: any) => {
            const activity = frame.handActivity || 'none';
            return {
              oneHand: activity === 'one-hand' ? 1 : 0,
              twoHands: activity === 'two-hands' ? 1 : 0,
              none: activity === 'none' ? 1 : 0,
            };
          }) || [],
          postureHint: rawMetrics.framesLog?.map((frame: any) => frame.postureHint || 'unknown') || [],
          yaw: rawMetrics.framesLog?.map((frame: any) => frame.yaw) || [],
          pitch: rawMetrics.framesLog?.map((frame: any) => frame.pitch) || [],
          roll: rawMetrics.framesLog?.map((frame: any) => frame.roll) || [],
          objectLabelCounts: rawMetrics.framesLog?.map((frame: any) => {
            const counts: { [key: string]: number } = {};
            (frame.objects || []).forEach((obj: any) => {
              counts[obj.label] = (counts[obj.label] || 0) + 1;
            });
            return counts;
          }) || [],
          blinkCount: rawMetrics.framesLog?.map((frame: any) => (frame.ear !== undefined && frame.ear < 0.2) ? 1 : 0) || [],
          multiPersonWarnings: rawMetrics.multiPersonWarnings || 0,
          nodCount: rawMetrics.nodCount || 0,
          shakeCount: rawMetrics.shakeCount || 0,
          topEmotionTrends: Object.entries(rawMetrics.emotionTopCounts || {}).map(([emotion, count]) => ({ emotion, count: count as number })),
          offscreenSeconds: [rawMetrics.offscreenSeconds || 0],
          blinkRatePerMin: [rawMetrics.blinkRatePerMin || 0],
        };

        setSessionMetrics(transformedMetrics);
      } catch (e: any) {
        console.error("Failed to fetch session metrics:", e);
        setError(`Failed to load report: ${e?.message || e}`);
      } finally {
        setLoading(false);
      }
    };

    void fetchLatestReport();
  }, []);

  const renderInsights = () => {
    if (loading) return <p className="text-center text-gray-600">Loading interview report...</p>
    if (error) return <p className="text-center text-red-500">Error: {error}</p>
    if (!sessionMetrics || !processedMetrics) return <p className="text-center text-gray-600">No report data available.</p>

    const {
      engagementData, emotionData, stressData, engagementTimeline, radarData, postureChartData,
      overallScore, confidenceLevel, techQuality, avgEyeContact, attentionSpan, professionalismScore
    } = processedMetrics

    const totalBlinks = sessionMetrics.blinkCount.reduce((sum, val) => sum + val, 0)
    const dominantEmotion = sessionMetrics.topEmotionTrends.length > 0
      ? sessionMetrics.topEmotionTrends[0].emotion
      : "N/A"
    
    const emotionKeys = Object.keys(sessionMetrics.emotionsAvg5[0] || {})
    const insights = getInsightMessage(processedMetrics)
    
    const colors = ['#8884d8', '#82ca9d', '#ffc658', '#ff7c7c', '#8dd1e1']

    return (
      <div className="space-y-6">
        {/* Executive Summary Dashboard */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <Card className={`${overallScore > 75 ? 'bg-green-50 border-green-200' : overallScore > 50 ? 'bg-yellow-50 border-yellow-200' : 'bg-red-50 border-red-200'}`}>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold">{overallScore}/100</div>
              <div className="text-sm text-gray-600">Overall Score</div>
            </CardContent>
          </Card>
          
          <Card className={`${confidenceLevel > 70 ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'}`}>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold">{confidenceLevel}%</div>
              <div className="text-sm text-gray-600">Confidence Level</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold">{techQuality}%</div>
              <div className="text-sm text-gray-600">Tech Setup Quality</div>
            </CardContent>
          </Card>
          
          <Card className={`${attentionSpan > 80 ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'}`}>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold">{attentionSpan}%</div>
              <div className="text-sm text-gray-600">Attention Span</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold">{professionalismScore}%</div>
              <div className="text-sm text-gray-600">Professionalism</div>
            </CardContent>
          </Card>
        </div>

        {/* Dynamic Insights Panel */}
        {insights.length > 0 && (
          <Card>
            <CardHeader><CardTitle>Key Insights</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-2">
                {insights.map((insight, index) => (
                  <div
                    key={index}
                    className={`p-3 rounded-md ${
                      insight.type === 'success' ? 'bg-green-100 border-l-4 border-green-500' :
                      insight.type === 'warning' ? 'bg-yellow-100 border-l-4 border-yellow-500' :
                      'bg-blue-100 border-l-4 border-blue-500'
                    }`}
                  >
                    {insight.message}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Professional Assessment Radar Chart */}
        <Card>
          <CardHeader><CardTitle>Professional Assessment Comparison</CardTitle></CardHeader>
          <CardContent>
            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart data={radarData}>
                  <PolarGrid />
                  <PolarAngleAxis dataKey="metric" />
                  <PolarRadiusAxis domain={[0, 100]} />
                  <Radar name="Candidate" dataKey="value" stroke="#8884d8" fill="#8884d8" fillOpacity={0.3} />
                  <Radar name="Benchmark" dataKey="benchmark" stroke="#82ca9d" fill="transparent" strokeDasharray="5 5" />
                  <Legend />
                </RadarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-sm text-gray-500 mt-2">
              Blue area shows candidate performance vs industry benchmarks (dashed green line)
            </p>
          </CardContent>
        </Card>

        {/* Enhanced Engagement Timeline */}
        <Card>
          <CardHeader><CardTitle>Engagement Timeline by Interview Phase</CardTitle></CardHeader>
          <CardContent>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={engagementTimeline}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="frame" />
                  <YAxis domain={[0, 100]} />
                  <Tooltip formatter={(value, name) => [`${value}%`, name]} />
                  <Area type="monotone" dataKey="engagement" stroke="#8884d8" fill="#8884d8" fillOpacity={0.6} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Stress Analysis */}
        <Card>
          <CardHeader><CardTitle>Stress Pattern Analysis</CardTitle></CardHeader>
          <CardContent>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart data={stressData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="frame" name="Time" />
                  <YAxis dataKey="stress" name="Stress Index" />
                  <Tooltip cursor={{ strokeDasharray: '3 3' }} />
                  <Scatter name="Stress Level" dataKey="stress" fill="#ff7c7c" />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <p className="text-sm text-gray-500 mt-2">
              Higher points indicate increased stress signals (blink rate, hand movement, head instability)
            </p>
          </CardContent>
        </Card>

        {/* Enhanced existing charts with better styling */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Enhanced Emotional State Trends */}
          <Card>
            <CardHeader><CardTitle>Emotional State Progression</CardTitle></CardHeader>
            <CardContent>
              <p className="mb-4">Dominant Emotion: <span className="font-semibold">{dominantEmotion}</span></p>
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={emotionData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="frame" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    {emotionKeys.map((key, index) => (
                      <Area
                        key={key}
                        type="monotone"
                        dataKey={key}
                        stackId="1"
                        stroke={colors[index % colors.length]}
                        fill={colors[index % colors.length]}
                        fillOpacity={0.6}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Posture Distribution */}
          <Card>
            <CardHeader><CardTitle>Posture Distribution</CardTitle></CardHeader>
            <CardContent>
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={postureChartData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, percentage }) => `${name}: ${percentage}%`}
                      outerRadius={60}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {postureChartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-4 space-y-1">
                {postureChartData.map((item, index) => (
                  <div key={item.name} className="flex justify-between text-sm">
                    <span className="flex items-center">
                      <div 
                        className="w-3 h-3 rounded-full mr-2" 
                        style={{ backgroundColor: colors[index % colors.length] }}
                      ></div>
                      {item.name}
                    </span>
                    <span>{item.percentage}%</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Actionable Recommendations */}
        <Card>
          <CardHeader><CardTitle>Development Recommendations</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-3">
                <h4 className="font-semibold text-green-700">Strengths Identified</h4>
                {overallScore > 70 && <p className="text-sm">• Strong overall interview performance</p>}
                {avgEyeContact > 60 && <p className="text-sm">• Good eye contact maintenance</p>}
                {attentionSpan > 80 && <p className="text-sm">• Excellent attention and focus</p>}
                {confidenceLevel > 70 && <p className="text-sm">• High confidence level demonstrated</p>}
              </div>
              <div className="space-y-3">
                <h4 className="font-semibold text-amber-700">Development Areas</h4>
                {avgEyeContact < 50 && <p className="text-sm">• Practice maintaining eye contact with camera</p>}
                {attentionSpan < 70 && <p className="text-sm">• Minimize distractions during video calls</p>}
                {totalBlinks > 100 && <p className="text-sm">• Work on relaxation techniques to reduce stress</p>}
                {techQuality < 70 && <p className="text-sm">• Improve technical setup (lighting, positioning)</p>}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Preserve existing raw metrics display */}
        <h4 className="text-lg font-semibold text-gray-800 mt-8">Raw Metrics (Partial View)</h4>
        <pre className="bg-gray-100 p-4 rounded-md text-sm overflow-auto max-h-60">
          {JSON.stringify(sessionMetrics, null, 2)}
        </pre>
      </div>
    )
  }

  return (
    <Card className="w-full max-w-7xl mx-auto">
      <CardHeader>
        <CardTitle className="text-3xl font-bold text-center">Body Language Analytics Report</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {renderInsights()}
        <div className="flex justify-center gap-4 pt-4 border-t">
          <Button onClick={onStartNewInterview}>Start New Interview</Button>
        </div>
      </CardContent>
    </Card>
  )
}
