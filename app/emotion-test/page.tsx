// app/emotion-test/page.tsx
import EmotionDetector from "@/components/EmotionDetector";

export default function EmotionTestPage() {
  return (
    <main style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", padding: 20 }}>
      <EmotionDetector />
    </main>
  );
}
