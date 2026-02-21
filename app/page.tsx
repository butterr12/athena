"use client";
import { useState, useRef, useEffect } from "react";

type ProcessingPhase = "idle" | "loading" | "done";

interface ProcessingStep {
  name: string;
  url: string;
}

export default function HomePage() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const capturingRef = useRef(false);

  // Single processing frame: loading → sequential steps → final image + caption
  const [processingPhase, setProcessingPhase] = useState<ProcessingPhase>("idle");
  const [processingSteps, setProcessingSteps] = useState<ProcessingStep[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [resultCaption, setResultCaption] = useState<string | null>(null);
  const stepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const STEP_DURATION_MS = 2200;

  const PIPELINE_STEP_NAMES = [
    "Attenuated Channel Compensation (ACC)",
    "White Balance (YCbCr mean method)",
    "Tone Mapping",
    "HSL Model-Based Saturation Adjustment",
    "CLAHE",
    "Gamma Correction",
    "High-Pass Fusion",
  ] as const;

  const PIPELINE_STEP_LABELS = [
    "ACC",
    "White Balance",
    "Tone Mapping",
    "HSL",
    "CLAHE",
    "Gamma Correction",
    "High-Pass Fusion",
  ] as const;

  const screenshotRef = useRef<HTMLDivElement>(null);
  const [screenshotSize, setScreenshotSize] = useState<{ width: number; height: number } | null>(null);
  const pipelineCellRef = useRef<HTMLDivElement>(null);
  const [pipelineCellSize, setPipelineCellSize] = useState<{ width: number; height: number } | null>(null);
  const PIPELINE_BOX_SCALE = 0.30; // pipeline boxes = screenshot dimensions scaled down (wider, same aspect as screenshot)




const startCapture = async () => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();

      await new Promise<void>((resolve) => {
        if (videoRef.current!.videoWidth && videoRef.current!.videoHeight) {
          resolve();
        } else {
          videoRef.current!.onloadedmetadata = () => resolve();
        }
      });
    }

    setCapturing(true);
    capturingRef.current = true;

    const captureLoop = async () => {
      if (!capturingRef.current || !videoRef.current) return;

      const canvas = document.createElement("canvas");
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      canvas.getContext("2d")!.drawImage(videoRef.current, 0, 0);
      const dataUrl = canvas.toDataURL("image/png");
      
      // 1. Show the NEW image immediately in the screenshot frame
      setImageSrc(dataUrl);

      // 2. Wipe the OLD result and show processing in the processing frame
      setDescription(null);
      setResultCaption(null);
      setProcessingPhase("loading");
      setProcessingSteps([]);
      setCurrentStepIndex(0);

      // 3. Call API; then reveal pipeline steps one by one below
      const stepsCount = await sendForDescription(dataUrl);

      // 4. Wait for all steps to be shown (stepsCount * STEP_DURATION_MS), then 10 s, before next screenshot
      if (capturingRef.current) {
        const revealTotalMs = stepsCount * STEP_DURATION_MS;
        const delayBeforeNextCaptureMs = revealTotalMs + 10000;
        await new Promise((resolve) => setTimeout(resolve, delayBeforeNextCaptureMs));
        captureLoop();
      }
    };

    captureLoop();
  } catch (err) {
    console.error(err);
  }
};


const stopCapture = () => {
  capturingRef.current = false;
  setCapturing(false);
  if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
};


  const sendForDescription = async (dataUrl: string) => {
    const FETCH_TIMEOUT_MS = 120000; // 2 minutes
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const blob = await (await fetch(dataUrl)).blob();
      const formData = new FormData();
      formData.append("files", blob, "screenshot.png");

      const res = await fetch("http://localhost:8000/describe/", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`Server returned ${res.status} ${res.statusText}`);
      }

      const json = await res.json();
      console.log("[describe API] full JSON:", json);
      const intermediate = json.intermediate_images;
      if (intermediate && typeof intermediate === "object") {
        const keys = Object.keys(intermediate);
        console.log("[describe API] intermediate_images keys:", keys, "count:", keys.length);
      }
      const newDesc = `${capitalize(json.model1)}: ${cleanCaption(json.caption1)}
${capitalize(json.model2)}: ${cleanCaption(json.caption2)}`;
      setResultCaption(newDesc);
      setDescription(newDesc);

      if (intermediate && typeof intermediate === "object" && Object.keys(intermediate).length > 0) {
        const steps: ProcessingStep[] = Object.entries(intermediate).map(([name, url]) => ({
          name,
          url: url as string,
        }));
        setProcessingSteps(steps);
        setCurrentStepIndex(0);
        setProcessingPhase("done");
        clearTimeout(timeoutId);
        return steps.length;
      } else {
        setProcessingPhase("done");
        setProcessingSteps([]);
        return 0;
      }
    } catch (err) {
      clearTimeout(timeoutId);
      const message =
        err instanceof Error
          ? err.name === "AbortError"
            ? "Request timed out. Is the server running at http://localhost:8000?"
            : err.message
          : "Request failed.";
      setProcessingPhase("done");
      setProcessingSteps([]);
      setResultCaption(null);
      setDescription(message);
      if (err instanceof Error && err.name !== "AbortError") console.error(err);
      return 0;
    }
  };

const capitalize = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

const cleanCaption = (s: string) => {
  if (!s) return "";

  let text = s
    .replace(/[^a-zA-Z0-9\s]/g, "") 
    .replace(/\s+/g, " ")
    .trim();

  text = capitalize(text);

  return text.endsWith(".") ? text : `${text}.`;
};



  // Match processing frame size to screenshot box
  useEffect(() => {
    const el = screenshotRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setScreenshotSize({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [imageSrc]);

  // Match pipeline grid cell size to (1,1) cell
  useEffect(() => {
    const el = pipelineCellRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setPipelineCellSize({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [imageSrc]);

  // Reveal pipeline steps one by one after API returns
  useEffect(() => {
    if (processingPhase !== "done" || processingSteps.length === 0) return;
    if (currentStepIndex >= processingSteps.length - 1) return;
    stepIntervalRef.current = setInterval(() => {
      setCurrentStepIndex((prev) => {
        if (prev >= processingSteps.length - 1) {
          if (stepIntervalRef.current) clearInterval(stepIntervalRef.current);
          return prev;
        }
        return prev + 1;
      });
    }, STEP_DURATION_MS);
    return () => {
      if (stepIntervalRef.current) {
        clearInterval(stepIntervalRef.current);
        stepIntervalRef.current = null;
      }
    };
  }, [processingPhase, processingSteps.length]);

  useEffect(() => {
    return () => stopCapture();
  }, []);

  return (
    <main className="min-h-screen bg-black flex flex-col items-center justify-center p-6">
      <div className="right-circle"></div>
      <h1 className="text-4xl font-extrabold mb-6 text-white">
        Project ATHENA
      </h1>

      {!capturing && (
        <button onClick={startCapture} className="glow-button">
          Start Capture
        </button>
      )}

      {capturing && (
        <button onClick={stopCapture} className="glow-button" style={{ background: 'red' }}>
          Stop Capture
        </button>
      )}

      {/* Screenshot box: unchanged, scan runs here while loading */}
      {imageSrc && (
        <div
          ref={screenshotRef}
          className="mt-6 max-w-4xl w-full border border-gray-700 rounded-xl overflow-hidden shadow-xl relative"
        >
          <img
            src={imageSrc}
            alt="Screenshot"
            className="w-full h-auto object-contain"
          />
          <div className="absolute top-2 right-2 bg-gray-900 bg-opacity-70 text-white px-3 py-1 rounded-lg text-sm z-10">
            Screenshot
          </div>
          {processingPhase === "loading" && (
            <>
              <div
                key="loading-scan"
                className="scan-line-vertical scan-line-vertical--loop"
                style={{ animationDelay: 0 }}
              />
              <div className="absolute bottom-4 left-0 right-0 z-20 flex justify-center">
                <span className="text-gray-200 text-sm font-medium">Scanning image</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* Image Enhancement Pipeline: 2x4 grid, boxes = screenshot dimensions scaled down (~30%) */}
      <section className="mt-8 w-full max-w-6xl">
        <h2 className="text-xl font-semibold text-white mb-3">Image Enhancement Pipeline</h2>
        <div className="grid grid-cols-4 grid-rows-2 gap-3">
          {(() => {
            const boxSize = screenshotSize
              ? { width: screenshotSize.width * PIPELINE_BOX_SCALE, height: screenshotSize.height * PIPELINE_BOX_SCALE }
              : pipelineCellSize;
            return [
            { row: 0, col: 0, type: "input" as const },
            { row: 0, col: 1, stepIndex: 0 },
            { row: 0, col: 2, stepIndex: 1 },
            { row: 0, col: 3, stepIndex: 2 },
            { row: 1, col: 0, stepIndex: 6 },
            { row: 1, col: 1, stepIndex: 5 },
            { row: 1, col: 2, stepIndex: 4 },
            { row: 1, col: 3, stepIndex: 3 },
          ].map((slot) => {
            if (slot.type === "input") {
              return (
                <div
                  key="input"
                  ref={pipelineCellRef}
                  className="relative rounded-xl border border-gray-700 overflow-visible bg-gray-900/60 min-h-[140px] flex flex-col"
                  style={boxSize ? { width: boxSize.width, height: boxSize.height } : undefined}
                >
                  <div className="absolute inset-0 rounded-xl overflow-hidden">
                    {imageSrc ? (
                      <img src={imageSrc} alt="Screenshot" className="w-full h-full object-fill" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-500 text-xs">No capture</div>
                    )}
                  </div>
                  <div className="absolute top-2 left-2 z-10 bg-gray-900/80 text-white text-xs font-medium px-2 py-1 rounded">
                    Screenshot
                  </div>
                  <div className="absolute -right-8 top-1/2 -translate-y-1/2 z-20 px-2 text-white text-3xl font-bold pointer-events-none">→</div>
                </div>
              );
            }
            const i = slot.stepIndex!;
            const stepName = PIPELINE_STEP_NAMES[i];
            const stepLabel = PIPELINE_STEP_LABELS[i];
            const isCurrent = i === currentStepIndex;
            const isRevealed = i <= currentStepIndex && processingSteps[i]?.url;
            const arrowRight = slot.row === 0 && slot.col < 3;
            const arrowDown = slot.row === 0 && slot.col === 3;
            const arrowLeft = slot.row === 1 && slot.col > 0;
            return (
              <div
                key={`${slot.row}-${slot.col}`}
                className="relative rounded-xl border overflow-visible bg-gray-900/80 min-h-[140px] flex flex-col"
                style={{
                  borderColor: isCurrent ? "rgba(0, 191, 255, 0.6)" : "rgb(55 65 81)",
                  ...(boxSize ? { width: boxSize.width, height: boxSize.height } : {}),
                }}
              >
                <div className="absolute inset-0 rounded-xl overflow-hidden">
                  {isRevealed ? (
                    <>
                      <img src={processingSteps[i].url} alt={stepName} className="absolute inset-0 w-full h-full object-fill" />
                      {isCurrent && <div key={`scan-${i}`} className="scan-line-vertical scan-line-vertical--once" />}
                      <div className="absolute top-2 left-2 z-10 bg-gray-900/80 text-white text-xs font-medium px-2 py-1 rounded">{stepLabel}</div>
                    </>
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center p-2 text-center">
                      <span className="text-gray-500 text-xs font-medium">Step {i + 1}/7</span>
                      <span className="text-gray-500 text-[10px] leading-tight mt-0.5">{stepName}</span>
                    </div>
                  )}
                </div>
                {arrowRight && <div className="absolute -right-8 top-1/2 -translate-y-1/2 z-20 px-2 text-white text-3xl font-bold pointer-events-none">→</div>}
                {arrowDown && <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-5 z-20 py-2 text-white text-3xl font-bold pointer-events-none">↓</div>}
                {arrowLeft && <div className="absolute -left-8 top-1/2 -translate-y-1/2 z-20 px-2 text-white text-3xl font-bold pointer-events-none">←</div>}
              </div>
            );
          });
          })()}
        </div>
      </section>

      {processingPhase === "done" &&
        (resultCaption || description) &&
        (processingSteps.length === 0 || currentStepIndex >= processingSteps.length - 1) && (
        <div className="mt-6 max-w-4xl w-full p-4 rounded-xl bg-gray-900/80 text-white text-left border border-gray-700">
          {(resultCaption || description || "").split("\n").map((line, i) => (
            <div key={i} className={description && !resultCaption ? "text-red-300" : ""}>{line}</div>
          ))}
        </div>
      )}


      <video ref={videoRef} style={{ display: "none" }} />
    </main>
  );
}
