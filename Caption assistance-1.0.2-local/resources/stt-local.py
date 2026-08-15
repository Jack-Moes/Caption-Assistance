# stt-local.py -- local real-time speech-to-text for Caption assistance using VOSK (Kaldi).
# Vosk uses its own Kaldi engine, NOT onnxruntime or ctranslate2 -- both of those crash with
# "Illegal instruction" on this machine's CPU-inference path, but Vosk runs fine.
# Single process (no multiprocessing -> no leaked workers). Emits one JSON object per line to stdout:
#   {"src":"mic"|"speaker","status":"partial"|"final"|"ready"|"error","text":"..."}
# One process per source. Killing the process stops it cleanly.
import sys, os, json, argparse
import numpy as np

RATE = 16000
FRAME_MS = 100                      # read ~100 ms per loop; Vosk still emits partials within it

def emit(src, status, text):
    try:
        sys.stdout.write(json.dumps({'src': src, 'status': status, 'text': ('' if text is None else str(text))}) + '\n')
        sys.stdout.flush()
    except Exception:
        pass

def resample_mono(a, ch, in_rate):
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    a = a.astype(np.float32)
    if in_rate != RATE and len(a) > 1:
        n = max(1, int(len(a) * RATE / in_rate))
        a = np.interp(np.linspace(0, len(a), n, endpoint=False), np.arange(len(a)), a)
    return a.astype(np.int16)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='mic')
    ap.add_argument('--device', default='')          # mic friendly-name substring
    ap.add_argument('--model', default='')            # vosk model dir (defaults to the bundled small model)
    ap.add_argument('--backend', default='vosk')
    args = ap.parse_args()
    src = args.src

    here = os.path.dirname(os.path.abspath(__file__))
    model_dir = args.model or os.path.join(here, 'models', 'vosk-model-small-en-us-0.15')

    try:
        from vosk import Model, KaldiRecognizer
    except Exception as e:
        emit(src, 'error', 'vosk not installed (' + str(e) + ') — click "Set up local model"'); return
    if not os.path.isdir(model_dir):
        emit(src, 'error', 'vosk model missing — click "Set up local model"'); return
    try:
        model = Model(model_dir)
        rec = KaldiRecognizer(model, RATE)
    except Exception as e:
        emit(src, 'error', 'vosk load failed: ' + str(e)); return

    # --- open the audio source (native rate/channels; we downmix+resample to 16k mono) ---
    try:
        if src == 'speaker':
            import pyaudiowpatch as pyaudio
            pa = pyaudio.PyAudio()
            wasapi = pa.get_host_api_info_by_type(pyaudio.paWASAPI)
            dev = pa.get_device_info_by_index(wasapi['defaultOutputDevice'])
            if not dev.get('isLoopbackDevice', False):
                for lb in pa.get_loopback_device_info_generator():
                    if dev['name'] in lb['name']:
                        dev = lb; break
            in_rate = int(dev['defaultSampleRate']); ch = int(dev['maxInputChannels']); dev_idx = dev['index']
        else:
            import pyaudio
            pa = pyaudio.PyAudio()
            dev_idx = None
            if args.device:
                for i in range(pa.get_device_count()):
                    di = pa.get_device_info_by_index(i)
                    if di.get('maxInputChannels', 0) > 0 and args.device.lower() in str(di.get('name', '')).lower():
                        dev_idx = i; break
            if dev_idx is None:
                dev_idx = pa.get_default_input_device_info()['index']
            di = pa.get_device_info_by_index(dev_idx)
            in_rate = int(di['defaultSampleRate']); ch = 1
        chunk = int(in_rate * FRAME_MS / 1000)
        stream = pa.open(format=pyaudio.paInt16, channels=ch, rate=in_rate, input=True,
                         frames_per_buffer=chunk, input_device_index=dev_idx)
    except Exception as e:
        emit(src, 'error', ('speaker' if src == 'speaker' else 'mic') + ' open failed: ' + str(e)); return

    emit(src, 'ready', '')
    last_partial = ''
    while True:
        try:
            raw = stream.read(chunk, exception_on_overflow=False)
        except Exception:
            continue
        frame = resample_mono(np.frombuffer(raw, dtype=np.int16), ch, in_rate)
        b = frame.tobytes()
        try:
            if rec.AcceptWaveform(b):
                txt = json.loads(rec.Result()).get('text', '')
                if txt:
                    emit(src, 'final', txt)
                last_partial = ''
            else:
                p = json.loads(rec.PartialResult()).get('partial', '')
                if p and p != last_partial:
                    emit(src, 'partial', p); last_partial = p
        except Exception:
            pass

if __name__ == '__main__':
    main()
