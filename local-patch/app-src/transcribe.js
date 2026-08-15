// transcribe.js -- live cloud speech-to-text for Caption assistance (runs in the renderer).
// Captures the mic (getUserMedia) or the speaker/system audio (getDisplayMedia loopback), downsamples
// to the engine's PCM rate via an AudioContext, and streams it over a WebSocket. Two cloud engines:
//   openai   : Realtime transcription API, gpt-4o-mini-transcribe, 24 kHz pcm16, base64 append frames
//   deepgram : wss://api.deepgram.com/v1/listen, nova-3, 16 kHz linear16, raw binary frames
// Auth is passed as a WebSocket SUBPROTOCOL (renderer sockets can't set headers):
//   deepgram -> ['token', <key>]              openai -> ['realtime','openai-insecure-api-key.<key>','openai-beta.realtime-v1']
// Exposes window.CATranscriber. onText(text,status) is called with 'partial' | 'final'.
(function () {
  'use strict';

  function floatTo16(f32) {
    var out = new Int16Array(f32.length);
    for (var i = 0; i < f32.length; i++) { var s = f32[i]; s = s < -1 ? -1 : (s > 1 ? 1 : s); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    return out;
  }
  function b64(bytes) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  async function micStream(deviceName) {
    var constraint = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    try {
      if (deviceName && navigator.mediaDevices.enumerateDevices) {
        var list = await navigator.mediaDevices.enumerateDevices();
        var m = list.find(function (d) { return d.kind === 'audioinput' && d.label && d.label.indexOf(deviceName) >= 0; });
        if (m && m.deviceId) constraint.deviceId = { exact: m.deviceId };
      }
    } catch (e) {}
    return navigator.mediaDevices.getUserMedia({ audio: constraint });
  }
  async function speakerStream() {
    // main's setDisplayMediaRequestHandler returns { video: screen, audio: 'loopback' }, so this resolves
    // silently (no picker) to the system output; keep only the audio track and drop the video.
    var s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    s.getVideoTracks().forEach(function (t) { t.stop(); });
    return s;
  }

  var RATE = { openai: 24000, deepgram: 16000, elevenlabs: 16000, speechmatics: 16000 };

  function CATranscriber(opts) {
    this.engine = opts.engine;              // 'openai' | 'deepgram'
    this.source = opts.source;              // 'mic' | 'speaker'
    this.key = (opts.key || '').trim();
    this.deviceName = opts.deviceName || '';
    this.onText = opts.onText || function () {};     // (text, 'partial'|'final')
    this.onStatus = opts.onStatus || function () {}; // (state, detail)  state: 'live'|'error'|'closed'
    this.ws = null; this.ctx = null; this.stream = null; this.proc = null;
    this.want = false; this.ready = false; this.retries = 0;
    this.dgFinals = []; this.oaiPartial = ''; this._ka = null;
  }
  CATranscriber.prototype.start = async function () {
    if (!this.key) { this.onStatus('error', 'no API key for ' + this.engine); return; }
    this.want = true;
    try { this.stream = this.source === 'mic' ? await micStream(this.deviceName) : await speakerStream(); }
    catch (e) { this.onStatus('error', (this.source === 'speaker' ? 'system-audio capture failed: ' : 'mic capture failed: ') + (e && e.message || e)); this.want = false; return; }
    try {
      var rate = RATE[this.engine] || 16000;
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: rate });
      var src = this.ctx.createMediaStreamSource(this.stream);
      var proc = this.ctx.createScriptProcessor(4096, 1, 1);
      var mute = this.ctx.createGain(); mute.gain.value = 0;   // run the processor with NO audible playback (no echo/feedback)
      src.connect(proc); proc.connect(mute); mute.connect(this.ctx.destination);
      this.proc = proc;
      var self = this;
      proc.onaudioprocess = function (e) { if (self.want && self.ready) self._audio(e.inputBuffer.getChannelData(0)); };
    } catch (e) { this.onStatus('error', 'audio pipeline: ' + (e && e.message || e)); this.stop(); return; }
    this._open();
  };
  CATranscriber.prototype._audio = function (f32) {
    if (!this.ws || this.ws.readyState !== 1) return;
    var i16 = floatTo16(f32);
    if (this.engine === 'deepgram' || this.engine === 'speechmatics') { try { this.ws.send(i16.buffer); } catch (e) {} }   // raw binary PCM
    else if (this.engine === 'elevenlabs') { try { this.ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: b64(new Uint8Array(i16.buffer)), sample_rate: 16000 })); } catch (e) {} }
    else { try { this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64(new Uint8Array(i16.buffer)) })); } catch (e) {} }   // openai
  };
  CATranscriber.prototype._open = function () {
    if (!this.want) return;
    if (this.retries > 4) { this.onStatus('error', this.engine + ' connection keeps failing — check the API key / network'); this.want = false; return; }
    if (this.engine === 'deepgram') this._openDeepgram();
    else if (this.engine === 'elevenlabs') this._openElevenLabs();
    else if (this.engine === 'speechmatics') this._openSpeechmatics();
    else this._openOpenAI();
  };
  CATranscriber.prototype._reopen = function () {
    this.ready = false; if (this._ka) { clearInterval(this._ka); this._ka = null; }
    var self = this; if (this.want) { this.retries++; setTimeout(function () { self._open(); }, 700); }
  };
  CATranscriber.prototype._openDeepgram = function () {
    var p = new URLSearchParams({
      model: 'nova-3', language: 'en-US', smart_format: 'true', punctuate: 'true',
      encoding: 'linear16', sample_rate: '16000', channels: '1',
      interim_results: 'true', endpointing: '300', utterance_end_ms: '1000', vad_events: 'true', no_delay: 'true'
    });
    var ws; try { ws = new WebSocket('wss://api.deepgram.com/v1/listen?' + p.toString(), ['token', this.key]); }
    catch (e) { this.onStatus('error', 'deepgram: ' + e.message); return; }
    this.ws = ws; var self = this;
    ws.onopen = function () { self.ready = true; self.retries = 0; self.onStatus('live'); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'Results' || m.channel) {
        var alt = m.channel && m.channel.alternatives && m.channel.alternatives[0];
        var t = alt && alt.transcript; if (!t) return;
        if (m.is_final) {
          self.dgFinals.push(t);
          if (m.speech_final) { self.onText(self.dgFinals.join(' '), 'final'); self.dgFinals = []; }
          else self.onText(self.dgFinals.join(' '), 'partial');
        } else { self.onText(self.dgFinals.concat(t).join(' '), 'partial'); }
      } else if (m.type === 'UtteranceEnd') {
        if (self.dgFinals.length) { self.onText(self.dgFinals.join(' '), 'final'); self.dgFinals = []; }
      }
    };
    ws.onerror = function () { self.onStatus('error', 'deepgram socket error'); };
    ws.onclose = function () { self._reopen(); };
    this._ka = setInterval(function () { if (ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch (e) {} } }, 8000);
  };
  CATranscriber.prototype._openOpenAI = function () {
    // GA Realtime transcription: wss://api.openai.com/v1/realtime?intent=transcription, key as a
    // subprotocol, then session.update on session.created (the beta *_session.update shape is gone).
    var ws;
    try { ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', ['realtime', 'openai-insecure-api-key.' + this.key]); }
    catch (e) { this.onStatus('error', 'openai: ' + e.message); return; }
    this.ws = ws; var self = this;
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      var t = m.type || '';
      if (t === 'session.created') {
        try {
          ws.send(JSON.stringify({ type: 'session.update', session: {
            type: 'transcription',
            audio: { input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
              turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 200, silence_duration_ms: 200 }   // shorter pause -> commit each phrase sooner (OpenAI is utterance-based; this only trims the lag)
            } }
          } }));
        } catch (e) {}
      } else if (t === 'session.updated') { self.ready = true; self.retries = 0; self.onStatus('live'); }
      else if (t.indexOf('input_audio_transcription.delta') >= 0) { self.oaiPartial += (m.delta || ''); self.onText(self.oaiPartial, 'partial'); }
      else if (t.indexOf('input_audio_transcription.completed') >= 0) { self.onText(m.transcript || self.oaiPartial, 'final'); self.oaiPartial = ''; }
      else if (t === 'error') { self.onStatus('error', (m.error && m.error.message) || 'openai error'); }
    };
    ws.onerror = function () { self.onStatus('error', 'openai socket error'); };
    ws.onclose = function () { self._reopen(); };
  };
  CATranscriber.prototype._openElevenLabs = function () {
    // client-side auth: mint a single-use token with the api key, then connect with ?token=
    var self = this;
    fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', { method: 'POST', headers: { 'xi-api-key': this.key } })
      .then(function (r) { return r.ok ? r.json() : r.text().then(function (t) { throw new Error('token ' + r.status + ': ' + t.slice(0, 100)); }); })
      .then(function (j) {
        if (!self.want) return;
        var token = j.token || j.single_use_token || (typeof j === 'string' ? j : '');
        var p = new URLSearchParams({ model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000', language_code: 'en', commit_strategy: 'vad' });
        var ws = new WebSocket('wss://api.elevenlabs.io/v1/speech-to-text/realtime?' + p.toString() + '&token=' + encodeURIComponent(token));
        self.ws = ws;
        ws.onmessage = function (ev) {
          var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          var t = m.message_type || '';
          if (t === 'session_started') { self.ready = true; self.retries = 0; self.onStatus('live'); }
          else if (t === 'partial_transcript') { self.onText(m.text || '', 'partial'); }
          else if (t === 'final_transcript' || t === 'committed_transcript') { self.onText(m.text || '', 'final'); }
          else if (t === 'error' || m.error) { self.onStatus('error', m.error || m.message || 'elevenlabs error'); }
        };
        ws.onerror = function () { self.onStatus('error', 'elevenlabs socket error'); };
        ws.onclose = function () { self._reopen(); };
      })
      .catch(function (e) { self.onStatus('error', 'elevenlabs auth: ' + (e && e.message || e)); self._reopen(); });
  };
  CATranscriber.prototype._openSpeechmatics = function () {
    // mint a short-lived JWT from the api key, then connect with ?jwt=; audio is only sent after RecognitionStarted (self.ready)
    var self = this;
    fetch('https://mp.speechmatics.com/v1/api_keys?type=rt', { method: 'POST', headers: { 'Authorization': 'Bearer ' + this.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 3600 }) })
      .then(function (r) { return r.ok ? r.json() : r.text().then(function (t) { throw new Error('key ' + r.status + ': ' + t.slice(0, 100)); }); })
      .then(function (j) {
        if (!self.want) return;
        var jwt = j.key_value || j.key || '';
        var ws = new WebSocket('wss://eu.rt.speechmatics.com/v2?jwt=' + encodeURIComponent(jwt));
        self.ws = ws;
        ws.onopen = function () {
          try { ws.send(JSON.stringify({ message: 'StartRecognition',
            audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
            transcription_config: { language: 'en', enable_partials: true, max_delay: 1.5, operating_point: 'enhanced' } })); } catch (e) {}
        };
        ws.onmessage = function (ev) {
          var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          var t = m.message || '';
          if (t === 'RecognitionStarted') { self.ready = true; self.retries = 0; self.onStatus('live'); }
          else if (t === 'AddPartialTranscript') { var p = m.metadata && m.metadata.transcript; if (p) self.onText(p, 'partial'); }
          else if (t === 'AddTranscript') { var f = m.metadata && m.metadata.transcript; if (f) self.onText(f, 'final'); }
          else if (t === 'Error') { self.onStatus('error', m.reason || m.type || 'speechmatics error'); }
        };
        ws.onerror = function () { self.onStatus('error', 'speechmatics socket error'); };
        ws.onclose = function () { self._reopen(); };
      })
      .catch(function (e) { self.onStatus('error', 'speechmatics auth: ' + (e && e.message || e)); self._reopen(); });
  };
  CATranscriber.prototype.stop = function () {
    this.want = false; this.ready = false;
    if (this._ka) { clearInterval(this._ka); this._ka = null; }
    try { if (this.ws) { this.ws.onclose = null; this.ws.close(); } } catch (e) {}
    try { if (this.proc) { this.proc.onaudioprocess = null; this.proc.disconnect(); } } catch (e) {}
    try { if (this.ctx) this.ctx.close(); } catch (e) {}
    try { if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    this.ws = null; this.ctx = null; this.proc = null; this.stream = null;
  };

  window.CATranscriber = CATranscriber;
})();
