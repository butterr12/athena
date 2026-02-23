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
  // Match the appended "(Inference Time: X.XXs)" that the server adds
  const match = raw.match(/^(.*?)\s*\(Inference Time:\s*([\d.]+s?)\)\s*$/s);
  if (match) {
    return { text: match[1].trim(), inferenceTime: match[2] };
  }
  return { text: raw.trim(), inferenceTime: null };
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
  const [modelResults, setModelResults] = useState<ModelResult[]>([]);
  const stepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const STEP_DURATION_MS = 100; // fast reveal

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
  const PIPELINE_BOX_SCALE = 0.30;

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

      const res = await fetch("http://localhost:80/describe/", {
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

  // Strips punctuation/symbols but NOT the caption text itself
  // NOTE: do NOT run this on the raw server string — parse inference time first
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

  const showResults =
    processingPhase === "done" &&
    modelResults.length > 0 &&
    (processingSteps.length === 0 || currentStepIndex >= processingSteps.length - 1);

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
        <button onClick={stopCapture} className="glow-button" style={{ background: "red" }}>
          Stop Capture
        </button>
      )}

      {/* Screenshot box */}
      {imageSrc && (
        <div
          ref={screenshotRef}
          className="mt-6 max-w-4xl w-full border border-gray-700 rounded-xl overflow-hidden shadow-xl relative"
        >
          <img src={imageSrc} alt="Screenshot" className="w-full h-auto object-contain" />
          <div className="absolute top-2 right-2 bg-gray-900 bg-opacity-70 text-white px-3 py-1 rounded-lg text-sm z-10">
            Screenshot
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

      {/* Image Enhancement Pipeline */}
      <section className="mt-8 w-full max-w-6xl">
        <h2 className="text-xl font-semibold text-white mb-3">Image Enhancement Pipeline</h2>
        {(() => {
          const boxSize = screenshotSize
            ? { width: screenshotSize.width * PIPELINE_BOX_SCALE, height: screenshotSize.height * PIPELINE_BOX_SCALE }
            : pipelineCellSize;
          const ARROW_COL = "3rem";
          const ARROW_ROW = "3rem";
          const gridCols = boxSize
            ? `${boxSize.width}px ${ARROW_COL} ${boxSize.width}px ${ARROW_COL} ${boxSize.width}px ${ARROW_COL} ${boxSize.width}px`
            : `1fr ${ARROW_COL} 1fr ${ARROW_COL} 1fr ${ARROW_COL} 1fr`;
          const gridRows = boxSize
            ? `${boxSize.height}px ${ARROW_ROW} ${boxSize.height}px`
            : `auto ${ARROW_ROW} auto`;
          const cells: {
            type: "input" | "step" | "arrow";
            row: number;
            col: number;
            stepIndex?: number;
            arrow?: "→" | "←" | "↓";
          }[] = [
            { type: "input", row: 0, col: 0 },
            { type: "arrow", row: 0, col: 1, arrow: "→" },
            { type: "step",  row: 0, col: 2, stepIndex: 0 },
            { type: "arrow", row: 0, col: 3, arrow: "→" },
            { type: "step",  row: 0, col: 4, stepIndex: 1 },
            { type: "arrow", row: 0, col: 5, arrow: "→" },
            { type: "step",  row: 0, col: 6, stepIndex: 2 },
            { type: "arrow", row: 1, col: 6, arrow: "↓" },
            { type: "step",  row: 2, col: 0, stepIndex: 6 },
            { type: "arrow", row: 2, col: 1, arrow: "←" },
            { type: "step",  row: 2, col: 2, stepIndex: 5 },
            { type: "arrow", row: 2, col: 3, arrow: "←" },
            { type: "step",  row: 2, col: 4, stepIndex: 4 },
            { type: "arrow", row: 2, col: 5, arrow: "←" },
            { type: "step",  row: 2, col: 6, stepIndex: 3 },
          ];
          return (
            <div
              className="grid items-center justify-items-center"
              style={{ gridTemplateColumns: gridCols, gridTemplateRows: gridRows }}
            >
              {cells.map((cell) => {
                if (cell.type === "arrow") {
                  return (
                    <div
                      key={`arrow-${cell.row}-${cell.col}`}
                      className="flex items-center justify-center text-white text-5xl font-bold pointer-events-none"
                      style={{ gridColumn: cell.col + 1, gridRow: cell.row + 1 }}
                    >
                      {cell.arrow}
                    </div>
                  );
                }
                if (cell.type === "input") {
                  return (
                    <div
                      key="input"
                      ref={pipelineCellRef}
                      className="relative rounded-xl border border-gray-700 overflow-hidden bg-gray-900/60 min-h-[140px] w-full h-full flex flex-col"
                      style={{
                        gridColumn: 1,
                        gridRow: 1,
                        ...(boxSize ? { width: boxSize.width, height: boxSize.height } : {}),
                      }}
                    >
                      {imageSrc ? (
                        <img src={imageSrc} alt="Screenshot" className="w-full h-full object-fill" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-500 text-xs">
                          No capture
                        </div>
                      )}
                      <div className="absolute top-2 left-2 z-10 bg-gray-900/80 text-white text-xs font-medium px-2 py-1 rounded">
                        Screenshot
                      </div>
                    </div>
                  );
                }
                const i = cell.stepIndex!;
                const stepName = PIPELINE_STEP_NAMES[i];
                const stepLabel = PIPELINE_STEP_LABELS[i];
                const isCurrent = i === currentStepIndex;
                const isRevealed = i <= currentStepIndex && !!processingSteps[i]?.url;
                return (
                  <div
                    key={`step-${i}`}
                    className="relative rounded-xl border overflow-hidden bg-gray-900/80 min-h-[140px] w-full h-full flex flex-col"
                    style={{
                      gridColumn: cell.col + 1,
                      gridRow: cell.row + 1,
                      borderColor: isCurrent ? "rgba(0, 191, 255, 0.6)" : "rgb(55 65 81)",
                      ...(boxSize ? { width: boxSize.width, height: boxSize.height } : {}),
                    }}
                  >
                    {isRevealed ? (
                      <>
                        <img
                          src={processingSteps[i].url}
                          alt={stepName}
                          className="absolute inset-0 w-full h-full object-fill"
                        />
                        {isCurrent && (
                          <div key={`scan-${i}`} className="scan-line-vertical scan-line-vertical--once" />
                        )}
                        <div className="absolute top-2 left-2 z-10 bg-gray-900/80 text-white text-xs font-medium px-2 py-1 rounded">
                          {stepLabel}
                        </div>
                      </>
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center p-2 text-center">
                        <span className="text-gray-500 text-xs font-medium">Step {i + 1}/7</span>
                        <span className="text-gray-500 text-[10px] leading-tight mt-0.5">{stepName}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}
      </section>

      {/* Model Results — shown after pipeline finishes revealing */}
      {showResults && (
        <div className="mt-6 max-w-4xl w-full rounded-xl bg-gray-900/80 border border-gray-700 overflow-hidden">
          {modelResults.map((result, i) => (
            <div
              key={i}
              className={`px-5 py-4 ${i < modelResults.length - 1 ? "border-b border-gray-700" : ""}`}
            >
              {/* Model name row */}
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-cyan-400 uppercase tracking-wider">
                  {result.model}
                </span>
                <span className="text-xs text-gray-500 font-mono">
                  ⏱ {result.inferenceTime}
                </span>
              </div>
              {/* Caption */}
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

      <video ref={videoRef} style={{ display: "none" }} />
    </main>
  );
}