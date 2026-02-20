(function () {
  'use strict';

  var screenLanding = document.getElementById('screen-landing');
  var screenChat = document.getElementById('screen-chat');
  var btnGoChat = document.getElementById('btn-go-chat');
  var closeChatBtn = document.getElementById('close-chat');
  var chatForm = document.getElementById('chat-form');
  var chatInput = document.getElementById('chat-input');
  var chatMessages = document.getElementById('chat-messages');
  var chatVoiceBtn = document.getElementById('chat-voice');

  function openChat() {
    screenLanding.classList.add('is-hidden');
    screenChat.removeAttribute('hidden');
    screenChat.classList.add('is-active');
    chatInput.focus();
    startWisprListening();
  }

  function closeChat() {
    screenChat.classList.remove('is-active');
    screenChat.setAttribute('hidden', '');
    screenLanding.classList.remove('is-hidden');
    stopWisprListening();
  }

  function scrollMessagesToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function addMessage(text, isUser) {
    var div = document.createElement('div');
    div.className = 'msg msg--' + (isUser ? 'user' : 'bot');
    var span = document.createElement('span');
    span.className = 'msg__text';
    span.textContent = text;
    div.appendChild(span);
    chatMessages.appendChild(div);
    scrollMessagesToBottom();
  }

  if (btnGoChat) btnGoChat.addEventListener('click', openChat);
  if (closeChatBtn) closeChatBtn.addEventListener('click', closeChat);

  var CODEWORD = 'маф';

  function sendChatMessage(text, speakReply) {
    addMessage(text, true);
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/chat');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function () {
      var reply = 'Не удалось получить ответ.';
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          if (data.reply) reply = data.reply;
        } catch (err) {}
      }
      addMessage(reply, false);
      if (speakReply) speakText(reply);
    };
    xhr.onerror = function () {
      addMessage('Ошибка соединения с сервером.', false);
    };
    xhr.send(JSON.stringify({ message: text }));
  }

  function speakText(text) {
    if (!window.speechSynthesis) return;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    u.rate = 0.95;
    function setRussianVoice() {
      var voices = speechSynthesis.getVoices();
      for (var i = 0; i < voices.length; i++) {
        if (voices[i].lang.startsWith('ru')) {
          u.voice = voices[i];
          break;
        }
      }
      speechSynthesis.speak(u);
    }
    if (speechSynthesis.getVoices().length) setRussianVoice();
    else speechSynthesis.onvoiceschanged = setRussianVoice;
  }

  if (chatForm && chatInput) {
    chatForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = chatInput.value.trim();
      if (!text) return;
      chatInput.value = '';
      chatInput.style.height = 'auto';
      var isCodeword = text.toLowerCase().trim() === CODEWORD;
      sendChatMessage(text, isCodeword);
    });
  }

  // ----- Wispr: запись чанками, кодовое слово "маф" — старт/стоп
  var CHUNK_MS = 2500;
  var voiceState = 'idle';
  var voiceBuffer = '';
  var wisprStream = null;
  var wisprRecorder = null;
  var wisprChunks = [];
  var wisprTimer = null;
  var wisprActive = false;

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () {
        if (typeof reader.result === 'string') {
          resolve(reader.result.split(',')[1]);
        } else {
          reject(new Error('Failed to convert blob to base64'));
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function convertWebMToWAV(webmBlob) {
    return new Promise(function (resolve, reject) {
      var audioContext = new (window.AudioContext || window.webkitAudioContext)();
      var reader = new FileReader();
      reader.onloadend = function () {
        audioContext.decodeAudioData(reader.result).then(function (audioBuffer) {
          var targetSampleRate = 16000;
          var ratio = targetSampleRate / audioBuffer.sampleRate;
          var newLength = Math.floor(audioBuffer.length * ratio);
          var offline = new OfflineAudioContext(1, newLength, targetSampleRate);
          var source = offline.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(offline.destination);
          source.start(0);
          offline.startRendering().then(function (rendered) {
            var ch = rendered.getChannelData(0);
            var len = ch.length * 2 + 44;
            var buf = new ArrayBuffer(len);
            var view = new DataView(buf);
            var offset = 0;
            function w(s) { for (var i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i)); }
            w('RIFF');
            view.setUint32(offset, 36 + ch.length * 2, true); offset += 4;
            w('WAVE');
            w('fmt ');
            view.setUint32(offset, 16, true); offset += 4;
            view.setUint16(offset, 1, true); offset += 2;
            view.setUint16(offset, 1, true); offset += 2;
            view.setUint32(offset, targetSampleRate, true); offset += 4;
            view.setUint32(offset, targetSampleRate * 2, true); offset += 4;
            view.setUint16(offset, 2, true); offset += 2;
            view.setUint16(offset, 16, true); offset += 2;
            w('data');
            view.setUint32(offset, ch.length * 2, true); offset += 4;
            for (var i = 0; i < ch.length; i++) {
              var s = ch[i];
              view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
              offset += 2;
            }
            resolve(new Blob([view], { type: 'audio/wav' }));
          }).catch(reject);
        }).catch(reject);
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(webmBlob);
    });
  }

  function processWisprText(text) {
    if (!text || !text.trim()) return;
    text = text.trim();
    var lower = text.toLowerCase();

    if (voiceState === 'idle') {
      if (lower.indexOf(CODEWORD) !== -1) {
        voiceState = 'recording';
        voiceBuffer = text.replace(new RegExp('^.*?' + CODEWORD + '\\s*', 'i'), '').trim();
        if (chatVoiceBtn) {
          chatVoiceBtn.classList.add('chat__voice--active');
          chatVoiceBtn.setAttribute('aria-label', 'Идёт запись — скажите «маф» чтобы отправить');
        }
      }
      return;
    }

    if (voiceState === 'recording') {
      voiceBuffer += (voiceBuffer ? ' ' : '') + text;
      if (lower.indexOf(CODEWORD) !== -1) {
        var message = voiceBuffer.replace(/\s*маф\s*$/i, '').trim();
        voiceState = 'idle';
        voiceBuffer = '';
        if (chatVoiceBtn) {
          chatVoiceBtn.classList.remove('chat__voice--active');
          chatVoiceBtn.setAttribute('aria-label', 'Голосовой ввод');
        }
        if (message) {
          var isCodewordOnly = message.toLowerCase() === CODEWORD;
          sendChatMessage(message, isCodewordOnly);
        }
      }
    }
  }

  function recordAndSendChunk() {
    if (!wisprActive || !wisprStream || !screenChat.classList.contains('is-active')) return;
    wisprChunks = [];
    try {
      wisprRecorder = new MediaRecorder(wisprStream, { mimeType: 'audio/webm;codecs=opus' });
    } catch (e) {
      try { wisprRecorder = new MediaRecorder(wisprStream); } catch (e2) { return; }
    }
    wisprRecorder.ondataavailable = function (e) {
      if (e.data.size) wisprChunks.push(e.data);
    };
    wisprRecorder.onstop = function () {
      if (wisprChunks.length === 0) {
        scheduleNextChunk();
        return;
      }
      var webmBlob = new Blob(wisprChunks, { type: 'audio/webm' });
      convertWebMToWAV(webmBlob).then(function (wavBlob) {
        return blobToBase64(wavBlob);
      }).then(function (base64) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/transcribe');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () {
          if (xhr.status === 200) {
            try {
              var data = JSON.parse(xhr.responseText);
              if (data.text) processWisprText(data.text);
            } catch (err) {}
          }
          scheduleNextChunk();
        };
        xhr.onerror = function () { scheduleNextChunk(); };
        xhr.send(JSON.stringify({ audio: base64 }));
      }).catch(function () { scheduleNextChunk(); });
    };
    wisprRecorder.start();
    wisprTimer = setTimeout(function () {
      if (wisprRecorder && wisprRecorder.state === 'recording') wisprRecorder.stop();
    }, CHUNK_MS);
  }

  function scheduleNextChunk() {
    wisprTimer = null;
    if (!wisprActive || !screenChat.classList.contains('is-active')) return;
    wisprTimer = setTimeout(recordAndSendChunk, 300);
  }

  function startWisprListening() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    if (wisprActive) return;
    wisprActive = true;
    voiceState = 'idle';
    voiceBuffer = '';
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      wisprStream = stream;
      if (chatVoiceBtn) chatVoiceBtn.setAttribute('aria-label', 'Скажите «маф» — начать запись, «маф» — отправить');
      scheduleNextChunk();
    }).catch(function () {
      wisprActive = false;
      if (chatVoiceBtn) chatVoiceBtn.setAttribute('title', 'Нет доступа к микрофону');
    });
  }

  function stopWisprListening() {
    wisprActive = false;
    if (wisprTimer) {
      clearTimeout(wisprTimer);
      wisprTimer = null;
    }
    if (wisprRecorder && wisprRecorder.state !== 'inactive') {
      try { wisprRecorder.stop(); } catch (e) {}
    }
    wisprRecorder = null;
    if (wisprStream) {
      wisprStream.getTracks().forEach(function (t) { t.stop(); });
      wisprStream = null;
    }
    voiceState = 'idle';
    voiceBuffer = '';
    if (chatVoiceBtn) {
      chatVoiceBtn.classList.remove('chat__voice--active');
      chatVoiceBtn.setAttribute('aria-label', 'Голосовой ввод');
    }
  }

  // Автовысота textarea
  if (chatInput) {
    chatInput.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
  }

  // Кнопка микрофона — индикатор: красная, когда идёт запись по «маф»
  if (chatVoiceBtn) {
    chatVoiceBtn.setAttribute('title', 'Скажите «маф» — начать запись, «маф» — отправить (Wispr)');
  }
})();
