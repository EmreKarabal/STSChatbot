/* ---------- DOM ---------- */
const startBtn  = document.getElementById("startBtn");
const stopBtn   = document.getElementById("stopBtn");
const logsEl    = document.getElementById("logs");
const promptEl  = document.getElementById("promptInput");
const saveBtn   = document.getElementById("savePromptBtn");

/* ---------- State ---------- */
let pc, dc, localTrack, audioEl;
let userPrompt = "";

/* ---------- Helpers ---------- */
function log(...a){
  console.log(...a);
  logsEl.textContent += a.join(" ") + "\n";
  logsEl.scrollTop = logsEl.scrollHeight;
}

/* ---------- Prompt Kaydet ---------- */
saveBtn.addEventListener("click", () => {
  userPrompt = promptEl.value.trim();
  if (!userPrompt){ alert("Önce prompt girin."); return; }
  log("💾  Prompt kaydedildi.");
  if (dc && dc.readyState==="open") sendPromptToSession();
});

/* ---------- Bağlan ---------- */
export async function connect(){
  if (!userPrompt){ alert("Önce prompt kaydedin."); return; }
  startBtn.disabled = true; stopBtn.disabled = false;

  /* 1 – Ephemeral key */
  const { client_secret, id:sessionId } = await (await fetch("/session")).json();
  const EPHEMERAL_KEY = client_secret.value;

  /* 2 – Peer & Data‑channel */
  pc = new RTCPeerConnection();
  dc = pc.createDataChannel("oai-events");

  dc.onopen = () => sendPromptToSession(true);

  dc.onmessage = async (e) => {
    const evt = JSON.parse(e.data);

    if (evt.type==="input_audio_buffer.speech_started")  log("🗣️  Konuşma başladı");
    if (evt.type==="input_audio_buffer.speech_stopped")  log("🤫  Konuşma bitti");
    if (evt.type==="response.done")                      log("🔈  Yanıt tamam");
    if (evt.type==="error")                              log("⚠️  Hata:", evt.message);

    /* ---------- Function Call ---------- */
    if (evt.type==="response.done" &&
        evt.response?.output?.[0]?.type==="function_call"){
      await handleFunctionCall(evt.response.output[0]);
    }
  };

  /* 3 – Remote audio */
  audioEl = new Audio(); audioEl.autoplay = true;
  pc.ontrack = (e)=>{ audioEl.srcObject=e.streams[0]; };

  /* 4 – Mikrofon */
  const stream = await navigator.mediaDevices.getUserMedia({
    audio:{noiseSuppression:true,echoCancellation:true,autoGainControl:false}
  });
  localTrack = stream.getTracks()[0]; pc.addTrack(localTrack);

  /* 5 – SDP Offer / Answer */
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  const sdpRes = await fetch(
    "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    { method:"POST", body:offer.sdp,
      headers:{Authorization:`Bearer ${EPHEMERAL_KEY}`,"Content-Type":"application/sdp"} }
  );
  await pc.setRemoteDescription({type:"answer", sdp: await sdpRes.text()});
  log("✅  Bağlantı kuruldu — Session:", sessionId);
}

/* ---------- Session.update gönder ---------- */
function sendPromptToSession(includeVad=false){
  const payload = {
    type:"session.update",
    session:{
      instructions:`Tüm yanıtlarını Türkçe ver. ${userPrompt}`,
      tools:[
        {
          type:"function",
          name:"get_weather",
          description:"Şehir için güncel sıcaklık & hava açıklaması getir.",
          parameters:{
            type:"object",
            properties:{ city:{type:"string",description:"Şehir adı"} },
            required:["city"]
          }
        },
        {
          type:"function",
          name:"get_rate",
          description:"İki para birimi arasındaki kuru getir.",
          parameters:{
            type:"object",
            properties:{
              base:{type:"string",description:"Baz para (örn USD)"},
              target:{type:"string",description:"Hedef para (örn TRY)"}
            },
            required:["target"]
          }
        },
        {
          type:"function",
          name:"get_metar",
          description:"Havalimanının METAR raporunu getir.",
          parameters: {
            type:"object",
            properties: {
              icao:{type:"string", description: "Havalimanının icao kodu"}
            },
            required: ["icao"]
          }
        }
      ],
      tool_choice:"auto"
    }
  };

  if (includeVad){
    Object.assign(payload.session,{
      turn_detection:{
        type:"server_vad",
        threshold:0.75,
        prefix_padding_ms:300,
        silence_duration_ms:500,
        create_response:true,
        interrupt_response:true
      },
      input_audio_noise_reduction:{type:"near_field"}
    });
  }

  dc.send(JSON.stringify(payload));
  log("📜  Prompt + tools oturuma uygulandı.");
}

/* ---------- Function Call Handler ---------- */
async function handleFunctionCall(call){
  const {name, arguments:argsJSON, call_id} = call;
  let output;
  try{
    const args = JSON.parse(argsJSON||"{}");

    if (name==="get_weather"){
      const q = new URLSearchParams({city:args.city}).toString();
      output = await (await fetch(`/tool/weather?${q}`)).json();

    } else if (name==="get_rate"){
      const q = new URLSearchParams({
        base:args.base||"USD",
        target:args.target
      }).toString();
      output = await (await fetch(`/tool/rate?${q}`)).json();

    } else if (name === 'get_metar'){
      const query = new URLSearchParams({ icao: args.icao}).toString();
      output = await (await fetch(`/tool/metar?${query}`)).json();
    }
    else {
      throw new Error("Unrecognized function: "+name);
    }

    /* 1. Fonksiyon çıktısını ekle */
    dc.send(JSON.stringify({
      type:"conversation.item.create",
      item:{
        type:"function_call_output",
        call_id,
        output: JSON.stringify(output)
      }
    }));
    log(`🔧 ${name} →`, JSON.stringify(output));

    /* 2. Modelden yanıt iste */
    dc.send(JSON.stringify({
      type:"response.create",
      response:{ modalities:["audio","text"] }
    }));
    log("📢  response.create gönderildi (fonksiyon sonrası)");

  }catch(err){
    log("❌ Function error:", err);
  }
}

/* ---------- Bağlantı kapat ---------- */
export function disconnect(){
  stopBtn.disabled = true; startBtn.disabled = false;
  if (dc) dc.close(); if (pc) pc.close(); if (localTrack) localTrack.stop();
  pc = dc = localTrack = null;
  log("⛔ Bağlantı kapatıldı");
}

startBtn.addEventListener("click", connect);
stopBtn .addEventListener("click", disconnect);