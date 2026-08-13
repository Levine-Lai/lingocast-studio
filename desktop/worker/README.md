# LingoCast Media Worker

`media_worker.py` is the process boundary for long-running local media work.
The desktop UI never invokes `yt-dlp`, Whisper, or FFmpeg directly. It sends
versioned JSON Lines commands to this worker and receives structured progress
events.

The first MVP exposes `health` and `pipeline_contract`. Later stages will adapt
the MIT-licensed JZSub acquisition, manifest, rendering, burn, and delivery
verification flow behind the same protocol.

Run checks with:

```powershell
python -m unittest desktop/worker/test_media_worker.py
python desktop/worker/media_worker.py --health
```
