"use client";
import { useState, useRef, useEffect } from "react";

type ProcessingPhase = "idle" | "loading" | "done";

interface ProcessingStep {
  name: string;
  url: string;
}

interface ModelResult {
  model: string;
  caption: string;
  inferenceTime: string; // e.g. "2.56s"
}

// Split "Some caption text. (Inference Time: 2.56s)" into parts
function parseCaption(raw: string): { text: string; inferenceTime: string | null } {
  const match = raw.match(/^(.*?)\s*\(Inference Time:\s*([\d.]+s?)\)\s*$/s);
  if (match) {
    return { text: match[1].trim(), inferenceTime: match[2] };
  }
  return { text: raw.trim(), inferenceTime: null };
}

// Helper: convert a File to a data URL
const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

export default function HomePage() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const capturingRef = useRef(false);

  // Processing pipeline
  const [processingPhase, setProcessingPhase] = useState<ProcessingPhase>("idle");
  const [processingSteps, setProcessingSteps] = useState<ProcessingStep[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [modelResults, setModelResults] = useState<ModelResult[]>([]);
  const stepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const STEP_DURATION_MS = 100; // fast reveal

  // Upload support
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Zoom modal state
  const [zoomedStep, setZoomedStep] = useState<ProcessingStep | null>(null);

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

        setImageSrc(dataUrl);
        setDescription(null);
        setModelResults([]);
        setProcessingPhase("loading");
        setProcessingSteps([]);
        setCurrentStepIndex(0);

        const stepsCount = await sendForDescription(dataUrl);

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
    const FETCH_TIMEOUT_MS = 120000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const blob = await (await fetch(dataUrl)).blob();
      const formData = new FormData();
      formData.append("files", blob, "screenshot.png");

      const res = await fetch("http://localhost:8080/describe/", {
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

      // Build model results for all 4 models
      const results: ModelResult[] = [];
      const modelKeys = [
        { model: "model1", caption: "caption1" },
        { model: "model2", caption: "caption2" },
        { model: "model3", caption: "caption3" },
        { model: "model4", caption: "caption4" },
      ];

      for (const { model, caption } of modelKeys) {
        if (json[model] && json[caption]) {
          const { text, inferenceTime } = parseCaption(json[caption]);
          results.push({
            model: json[model],
            caption: cleanCaption(text),
            inferenceTime: inferenceTime ?? "–",
          });
        }
      }

      setModelResults(results);
      setDescription("ok"); // signals done

      const intermediate = json.intermediate_images;
      if (intermediate && typeof intermediate === "object" && Object.keys(intermediate).length > 0) {
        const steps: ProcessingStep[] = Object.entries(intermediate).map(([name, url]) => ({
          name,
          url: url as string,
        }));
        setProcessingSteps(steps);
        setCurrentStepIndex(0);
        setProcessingPhase("done");
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
            ? "Request timed out. Is the server running at http://localhost:80?"
            : err.message
          : "Request failed.";
      setProcessingPhase("done");
      setProcessingSteps([]);
      setModelResults([]);
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

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Stop screen capture if active
    if (capturingRef.current) {
      stopCapture();
    }

    // Reset state
    setImageSrc(null);
    setDescription(null);
    setModelResults([]);
    setProcessingPhase("idle");
    setProcessingSteps([]);
    setCurrentStepIndex(0);

    try {
      const dataUrl = await fileToDataUrl(file);
      setUploadedFileName(file.name);
      setImageSrc(dataUrl);
      setProcessingPhase("loading");

      const stepsCount = await sendForDescription(dataUrl);
      console.log("Upload processed, steps:", stepsCount);
    } catch (err) {
      console.error("Upload failed:", err);
      setProcessingPhase("done");
      setDescription("Failed to process uploaded image.");
    }

    // Clear the file input so the same file can be reselected
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

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

  const showResults =
    processingPhase === "done" &&
    modelResults.length > 0 &&
    (processingSteps.length === 0 || currentStepIndex >= processingSteps.length - 1);

  // Close modal on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomedStep(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <main className="min-h-screen bg-black flex flex-col items-center justify-center p-6">
      <div className="right-circle"></div>
      <h1 className="text-4xl font-extrabold mb-6 text-white">
        Project ATHENA
      </h1>

      {/* Control buttons: screen capture and upload */}
      <div className="flex gap-4 flex-wrap justify-center">
        {!capturing ? (
          <button onClick={startCapture} className="glow-button">
            Start Capture
          </button>
        ) : (
          <button onClick={stopCapture} className="glow-button" style={{ background: "red" }}>
            Stop Capture
          </button>
        )}

        {/* Upload button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={capturing}
          className="glow-button"
        >
          Upload Image
        </button>

        <input
          type="file"
          accept="image/*"
          ref={fileInputRef}
          onChange={handleFileUpload}
          className="hidden"
        />
      </div>

      {/* Screenshot box */}
      {imageSrc && (
        <div className="mt-6 max-w-4xl w-full border border-gray-700 rounded-xl overflow-hidden shadow-xl relative">
          <img src={imageSrc} alt="Screenshot" className="w-full h-auto object-contain" />
          <div className="absolute top-2 right-2 bg-gray-900 bg-opacity-70 text-white px-3 py-1 rounded-lg text-sm z-10">
            {uploadedFileName ? `Upload: ${uploadedFileName}` : "Screenshot"}
          </div>
          {processingPhase === "loading" && (
            <>
              <div
                key="loading-scan"
                className="scan-line-vertical scan-line-vertical--loop"
                style={{ animationDelay: "0s" }}
              />
              <div className="absolute bottom-4 left-0 right-0 z-20 flex justify-center">
                <span className="text-gray-200 text-sm font-medium">Scanning image</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* Image Enhancement Flowchart */}
      {processingSteps.length > 0 && (
        <section className="mt-8 w-full max-w-6xl">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-white">Enhancement Pipeline</h2>
            <span className="text-sm text-gray-400">
              Step {currentStepIndex + 1} of {processingSteps.length}
            </span>
          </div>

          {/* Flowchart row */}
          <div className="flex items-center justify-center gap-1 flex-wrap">
            {processingSteps.map((step, idx) => {
              const label = PIPELINE_STEP_LABELS[idx] ?? step.name;
              const fullName = PIPELINE_STEP_NAMES[idx] ?? step.name;
              const isRevealed = idx <= currentStepIndex;
              const isCurrent = idx === currentStepIndex;

              return (
                <div key={step.name} className="flex items-center">
                  {/* Step node */}
                  <button
                    onClick={() => isRevealed && setZoomedStep(step)}
                    disabled={!isRevealed}
                    className={`
                      relative w-24 h-24 rounded-xl border-2 flex flex-col items-center justify-center
                      transition-all duration-300 group
                      ${isCurrent ? "border-cyan-400 shadow-lg shadow-cyan-500/30" : "border-gray-700"}
                      ${isRevealed ? "cursor-zoom-in hover:scale-105 hover:shadow-cyan-400/50" : "cursor-default opacity-70"}
                    `}
                  >
                    {isRevealed ? (
                      <>
                        <img
                          src={step.url}
                          alt={fullName}
                          className="absolute inset-0 w-full h-full object-cover rounded-xl"
                        />
                        {isCurrent && (
                          <div className="scan-line-vertical scan-line-vertical--once rounded-xl" />
                        )}
                        <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[10px] font-medium py-0.5 text-center rounded-b-xl">
                          {label}
                        </div>
                      </>
                    ) : (
                      <div className="text-center p-1">
                        <span className="text-gray-600 text-xl">?</span>
                        <p className="text-gray-500 text-[10px] mt-0.5 leading-tight">{label}</p>
                      </div>
                    )}
                  </button>

                  {/* Arrow (except after last step) */}
                  {idx < processingSteps.length - 1 && (
                    <div className="text-gray-600 text-2xl mx-1 select-none">→</div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Model Results */}
      {showResults && (
        <div className="mt-6 max-w-4xl w-full rounded-xl bg-gray-900/80 border border-gray-700 overflow-hidden">
          {modelResults.map((result, i) => (
            <div
              key={i}
              className={`px-5 py-4 ${i < modelResults.length - 1 ? "border-b border-gray-700" : ""}`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-cyan-400 uppercase tracking-wider">
                  {result.model}
                </span>
                <span className="text-xs text-gray-500 font-mono">
                  ⏱ {result.inferenceTime}
                </span>
              </div>
              <p className="text-white text-sm leading-relaxed">{result.caption}</p>
            </div>
          ))}
        </div>
      )}

      {/* Error state */}
      {processingPhase === "done" && modelResults.length === 0 && description && description !== "ok" && (
        <div className="mt-6 max-w-4xl w-full p-4 rounded-xl bg-gray-900/80 text-red-300 text-left border border-gray-700">
          {description}
        </div>
      )}

      {/* Zoom Modal */}
      {zoomedStep && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in"
          onClick={() => setZoomedStep(null)}
        >
          <div
            className="relative bg-gray-900 border border-gray-700 rounded-2xl p-4 max-w-2xl w-full mx-4 animate-scale-up"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="absolute top-2 right-2 text-gray-400 hover:text-white text-2xl leading-none"
              onClick={() => setZoomedStep(null)}
            >
              &times;
            </button>
            <img
              src={zoomedStep.url}
              alt={zoomedStep.name}
              className="w-full h-auto rounded-xl object-contain max-h-[70vh]"
            />
            <p className="text-center text-white text-sm mt-3 font-medium">
              {PIPELINE_STEP_NAMES[processingSteps.findIndex(s => s.name === zoomedStep.name)] ?? zoomedStep.name}
            </p>
          </div>
        </div>
      )}

      <video ref={videoRef} style={{ display: "none" }} />
    </main>
  );
}