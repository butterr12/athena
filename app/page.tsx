"use client";
import { useState, useRef, useEffect } from "react";

export default function HomePage() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const intervalRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const interval = 5000; 
  const [description, setDescription] = useState<string | null>(null);
const capturingRef = useRef(false);
const [flash, setFlash] = useState(false);




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
      
      // 1. Show the NEW image immediately
      setImageSrc(dataUrl);

      // 2. Wipe the OLD text immediately (Fixes mismatch)
      setDescription("Athena is thinking...");

      // 3. Get the new description
      await sendForDescription(dataUrl);

      // 4. PAUSE HERE so you can actually read the new description 
      if (capturingRef.current) {
        await new Promise(resolve => setTimeout(resolve, 13000)); //13 seconds, change lng if trip
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
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const formData = new FormData();
    formData.append("files", blob, "screenshot.png");

    const res = await fetch("http://localhost:8080/describe/", {
      method: "POST",
      body: formData,
    });

    const json = await res.json();

    const newDesc = `${capitalize(json.model1)}: ${cleanCaption(json.caption1)}
    ${capitalize(json.model2)}: ${cleanCaption(json.caption2)}`;


    if (newDesc !== description) {
      setDescription(newDesc);
    }
  } catch (err) {
    console.error(err);
    setDescription("Error fetching description");
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



  useEffect(() => {
    return () => stopCapture(); // cleanup on unmount
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

      {imageSrc && (
        <div className="mt-6 max-w-4xl w-full border border-gray-700 rounded-xl overflow-hidden shadow-xl relative">
          <img
            src={imageSrc}
            alt="Screenshot"
            className="w-full h-auto object-contain"
          />
          <div className="absolute top-2 right-2 bg-gray-900 bg-opacity-70 text-white px-3 py-1 rounded-lg text-sm">
            Screenshot
          </div>
        </div>
      )}

      {description && (
      <div className="mt-4 p-4 rounded-lg max-w-4xl text-left bg-gray-900 bg-opacity-70 text-white">
        {description.split("\n").map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>

      
      // <div
      //   className="mt-4 p-4 rounded-lg max-w-4xl text-left bg-gray-900 bg-opacity-70 text-white"
      // >
      //   {description}
      // </div>
    )}


      <video ref={videoRef} style={{ display: "none" }} />
    </main>
  );
}
