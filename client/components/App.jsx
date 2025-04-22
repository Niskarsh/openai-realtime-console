import { useEffect, useRef, useState } from "react";
import logo from "/assets/openai-logomark.svg";
import EventLog from "./EventLog";
import SessionControls from "./SessionControls";
import ToolPanel from "./ToolPanel";

export default function App() {
  // UI state and data channel
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [events, setEvents]                   = useState([]);
  const [dataChannel, setDataChannel]         = useState(null);

  // Core WebRTC connection
  const peerConnection = useRef(null);

  // Live playback of AI responses
  const audioElement = useRef(null);

  // ── NEW REFS FOR MIXED RECORDING ─────────────────────────────────
  const micStreamRef       = useRef(null);   // user mic MediaStream
  const aiStreamRef        = useRef(null);   // AI remote MediaStream
  const audioCtxRef        = useRef(null);   // Web AudioContext
  const destRef            = useRef(null);   // MediaStreamDestinationNode
  const recorderRef        = useRef(null);   // MediaRecorder
  const chunksRef          = useRef([]);     // collected audio chunks
  const recorderStartedRef = useRef(false);  // guard to start only once

  // wait until both mic & AI streams exist, then mix & start recording
  function maybeStartRecorder() {
    if (recorderStartedRef.current) return;
    if (!micStreamRef.current || !aiStreamRef.current) return;

    // 1) Create a Web AudioContext and a destination node
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ctx.createMediaStreamDestination();
    audioCtxRef.current = ctx;
    destRef.current     = dest;

    // 2) Route the mic into the destination
    const micSource = ctx.createMediaStreamSource(micStreamRef.current);
    micSource.connect(dest);

    // 3) Route the AI audio into the same destination
    const aiSource = ctx.createMediaStreamSource(aiStreamRef.current);
    aiSource.connect(dest);

    // 4) Start a MediaRecorder on that mixed stream
    const recorder = new MediaRecorder(dest.stream);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
    recorder.onstop = () => {
      // assemble and play back the recording
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const url  = URL.createObjectURL(blob);
      const player = document.createElement("audio");
      player.controls = true;
      player.src = url;
      document.body.appendChild(player);
      player.play();
    };

    recorder.start();
    recorderRef.current        = recorder;
    recorderStartedRef.current = true;
  }

  // ── START A REALTIME SESSION ────────────────────────────────────────
  async function startSession() {
    // 1) fetch an ephemeral OpenAI key
    const tokenRes = await fetch("/token");
    const data     = await tokenRes.json();
    const EPHEMERAL_KEY = data.client_secret.value;

    // 2) set up RTCPeerConnection
    const pc = new RTCPeerConnection();
    peerConnection.current = pc;

    // 3) configure live AI audio playback
    audioElement.current = document.createElement("audio");
    audioElement.current.autoplay = true;
    pc.ontrack = (e) => {
      // play AI audio in real time
      audioElement.current.srcObject = e.streams[0];
      // store the AI stream for mixing
      aiStreamRef.current = e.streams[0];
      // try to start recording once AI arrives
      maybeStartRecorder();
    };

    // 4) get mic and add to PC
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStreamRef.current = micStream;
    pc.addTrack(micStream.getAudioTracks()[0]);
    // try to start recording once mic exists
    maybeStartRecorder();

    // 5) open data channel for event messages
    const dc = pc.createDataChannel("oai-events");
    setDataChannel(dc);

    // 6) SDP handshake
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const baseUrl = "https://api.openai.com/v1/realtime";
    const model   = "gpt-4o-realtime-preview-2024-12-17";
    const sdpRes  = await fetch(`${baseUrl}?model=${model}`, {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${EPHEMERAL_KEY}`,
        "Content-Type": "application/sdp",
      },
    });
    const answer = { type: "answer", sdp: await sdpRes.text() };
    await pc.setRemoteDescription(answer);

    // mark session active once data channel is open
    dc.addEventListener("open", () => {
      setIsSessionActive(true);
      setEvents([]);
    });
  }

  // ── STOP SESSION & RECORDING ────────────────────────────────────────
  function stopSession() {
    // stop the recorder (triggers playback via onstop handler)
    recorderRef.current?.stop();
    recorderStartedRef.current = false;

    // clean up data channel
    if (dataChannel) dataChannel.close();

    // clean up PeerConnection and tracks
    peerConnection.current.getSenders().forEach((sender) => {
      sender.track?.stop();
    });
    peerConnection.current.close();
    peerConnection.current = null;

    setIsSessionActive(false);
    setDataChannel(null);
  }

  // ── SEND EVENTS TO OPENAI ────────────────────────────────────────────
  function sendClientEvent(message) {
    if (!dataChannel) {
      console.error("No data channel available", message);
      return;
    }
  
    // 1. Generate timestamp locally
    const ts = new Date().toLocaleTimeString();
    message.event_id = message.event_id || crypto.randomUUID();
    if (!message.timestamp) {
      message.timestamp = ts;
    }
  
    // 2. Clone and clean the payload for the API
    const payload = { ...message };
    delete payload.timestamp;
  
    // 3. Send the cleaned payload
    dataChannel.send(JSON.stringify(payload));
  
    // 4. Update local UI state with the full message (including timestamp)
    setEvents((prev) => [message, ...prev]);
  }
  

  function sendTextMessage(text) {
    sendClientEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    sendClientEvent({ type: "response.create" });
  }

  // ── COLLECT BACKEND EVENTS ───────────────────────────────────────────
  useEffect(() => {
    if (!dataChannel) return;
    dataChannel.addEventListener("message", (e) => {
      const event = JSON.parse(e.data);
      if (!event.timestamp) {
        event.timestamp = new Date().toLocaleTimeString();
      }
      setEvents((prev) => [event, ...prev]);
    });
  }, [dataChannel]);

  // ── RENDER ──────────────────────────────────────────────────────────
  return (
    <>
      <nav className="absolute top-0 left-0 right-0 h-16 flex items-center">
        <div className="flex items-center gap-4 w-full m-4 pb-2 border-0 border-b border-solid border-gray-200">
          <img style={{ width: "24px" }} src={logo} />
          <h1>realtime console</h1>
        </div>
      </nav>
      <main className="absolute top-16 left-0 right-0 bottom-0 flex">
        <section className="flex-1 px-4 overflow-y-auto">
          <EventLog events={events} />
        </section>
        <aside className="w-[380px] p-4 pt-0 overflow-y-auto bg-gray-50">
          <SessionControls
            startSession={startSession}
            stopSession={stopSession}
            sendClientEvent={sendClientEvent}
            sendTextMessage={sendTextMessage}
            events={events}
            isSessionActive={isSessionActive}
          />
          <ToolPanel
            sendClientEvent={sendClientEvent}
            sendTextMessage={sendTextMessage}
            events={events}
            isSessionActive={isSessionActive}
          />
        </aside>
      </main>
    </>
  );
}
