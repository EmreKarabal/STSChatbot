
const startBtn  = document.getElementById("startBtn");
const stopBtn   = document.getElementById("stopBtn");
const logsEl    = document.getElementById("logs");
const promptEl  = document.getElementById("promptInput");
const voiceEl   = document.getElementById('voiceSelect');
const saveBtn   = document.getElementById("savePromptBtn");
const micButton = document.getElementById('micButton');
const addVariableButton = document.getElementById('addVariableBtn');
const variablesContainer = document.getElementById('variablesContainer');
const variableTemplate = document.getElementById('variableTemplate');

let pc, dc, localTrack, audioEl;
let userPrompt = "";
let userVoice = 'alloy';
let isMicActive = false;
let isMicMuted = true;
let trackEnabled = false;
let variables = [];


function log(...a){
  console.log(...a);
  logsEl.textContent += a.join(" ") + "\n";
  logsEl.scrollTop = logsEl.scrollHeight;
}



saveBtn.addEventListener("click", () => {
  userPrompt = promptEl.value.trim();
  userVoice = voiceEl.value;
  if (!userPrompt){ alert("Önce prompt girin."); return; }
  log(`💾  Prompt kaydedildi. Seçilen ses: ${userVoice}`);
  sendPromptToSession();
});

addVariableButton.addEventListener('click', addVariable);

export async function connect(){
  if (!userPrompt){ alert("Önce prompt kaydedin."); return; }
  startBtn.disabled = true; 
  stopBtn.disabled = false;

  /* 1 – Ephemeral key */
  const { client_secret, id:sessionId } = await (await fetch("/session?voice=" + encodeURIComponent(userVoice))).json();
  const EPHEMERAL_KEY = client_secret.value;

  /* 2 – Peer & Data‑channel */
  pc = new RTCPeerConnection();
  dc = pc.createDataChannel("oai-events");

  dc.onopen = () => {

    sendPromptToSession(true);
    micButton.disabled = false;
    log("🎤  Mikrofon butonu aktif. Konuşmak için basılı tutun.");

  };

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
  localTrack = stream.getTracks()[0]; 
  localTrack.enabled = false;
  pc.addTrack(localTrack);

  /* 5 – SDP Offer / Answer */
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  const sdpRes = await fetch(
    "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    { method:"POST", body:offer.sdp,
      headers:{Authorization:`Bearer ${EPHEMERAL_KEY}`,"Content-Type":"application/sdp"} }
  );
  await pc.setRemoteDescription({type:"answer", sdp: await sdpRes.text()});
  log("✅  Bağlantı kuruldu — Session:", sessionId, `---Ses: ${userVoice}`);
}


function sendPromptToSession(includeVad=false){

  const processedPrompt = processPromptVariables(userPrompt);

  const payload = {
    type:"session.update",
    session:{
      instructions:`Tüm yanıtlarını Türkçe ver. ${processedPrompt}`,
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
        threshold:0.50,
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


async function handleFunctionCall(call){
  const {name, arguments:argsJSON, call_id} = call;
  let output;
  try{
    const args = JSON.parse(argsJSON||"{}");

    if (name==="get_weather"){
      const query = new URLSearchParams({city:args.city}).toString();
      output = await (await fetch(`/tool/weather?${query}`)).json();

    } else if (name==="get_rate"){
      const query = new URLSearchParams({
        base:args.base||"USD",
        target:args.target
      }).toString();
      output = await (await fetch(`/tool/rate?${query}`)).json();

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


export function disconnect(){
  stopBtn.disabled = true; startBtn.disabled = false;
  if (dc) dc.close(); if (pc) pc.close(); if (localTrack) localTrack.stop();
  pc = dc = localTrack = null;
  log("⛔ Bağlantı kapatıldı");
}

function setupMicrophoneButton(){

  micButton.addEventListener('mousedown', () => {

    if(localTrack) {

      localTrack.enabled = true;
      micButton.classList.add('active');
      log("Mikrofon aktif");

    }


  });


  micButton.addEventListener('mouseup', () => {

    if(localTrack){

      localTrack.enabled = false;
      micButton.classList.remove('active');
      log("Mikrofon kapatıldı.");

    }

  });

}

function addVariable(){

  const clone = document.importNode(variableTemplate.content, true);
  const variableItem = clone.querySelector('.variable-item');
  const deleteButton = clone.querySelector('.delete-variable-btn');


  deleteButton.addEventListener('click', () => {

    variableItem.parentNode.removeChild(variableItem);
    updateVariablesArray();

  });

  const nameInput = clone.querySelector('.variable-name');
  const valueInput = clone.querySelector('.variable-value');

  nameInput.addEventListener('input', updateVariablesArray);
  valueInput.addEventListener('input', updateVariablesArray);

  variablesContainer.appendChild(clone);
  updateVariablesArray();

}

function updateVariablesArray() {

  variables = [];
  const items = variablesContainer.querySelectorAll('.variable-item');


  items.forEach(item => {

    const nameEl = item.querySelector('.variable-name');
    const valueEl = item.querySelector('.variable-value');

    if(nameEl.value.trim()){

      variables.push({

        name: nameEl.value.trim(),
        value: valueEl.value.trim()

      });

    }

  });

  console.log('Güncel değişkenler: ', variables);

}

function processPromptVariables(promptText){

  if(!variables.length) return promptText;

  let processedPrompt = promptText;

  for (const variable of variables){

    const placeholder = `\${${variable.name}}`;
    let value = variable.value;


    if(value.startsWith('js:')) {

      try {

        const jsCode = value.substring(3);
        value = Function(`"use strict"; return (${jsCode})`)();
        log(`📊 Değişken ${variable.name} için kod çalıştırıldı: ${value}`);

      } catch (error) {

        log(`❌ ${variable.name} için kod çalıştırma hatası: ${error.message}`);
        value = `[${variable.name} hesaplanamadı: ${error.message}]`;

      }

    }

    processedPrompt = processedPrompt.replace(new RegExp(`\\$\\{${variable.name}}`, 'g'), value);

  }

  return processedPrompt;

}


setupMicrophoneButton();


startBtn.addEventListener("click", connect);
stopBtn .addEventListener("click", disconnect);


