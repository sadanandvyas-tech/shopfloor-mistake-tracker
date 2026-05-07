/**
 * camera.js
 *
 * Live camera capture for tablets/phones (and webcams on desktop).
 * Uses the MediaDevices API; falls back to a hidden <input capture> on
 * browsers without getUserMedia (older iOS/Android).
 *
 * Public API on window.Camera:
 *   Camera.open() -> Promise<File>
 *     Opens the camera modal, lets the user capture a frame, and resolves
 *     with a File ("image/jpeg"). Rejects if the user cancels or denies.
 */

(function (global) {
  let modal, video, canvas, stream, captureBtn, switchBtn, cancelBtn, statusEl;
  let resolveCapture, rejectCapture;
  let useFrontFacing = false;

  function ensureModal() {
    if (modal) return;

    modal = document.createElement("div");
    modal.id = "camera-modal";
    modal.className = "camera-modal hidden";
    modal.innerHTML =
      '<div class="camera-dialog">' +
        '<div class="camera-header">' +
          '<h3>Take a Photo</h3>' +
          '<button type="button" class="camera-close" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="camera-stage">' +
          '<video autoplay playsinline muted></video>' +
          '<div class="camera-status"></div>' +
        '</div>' +
        '<div class="camera-controls">' +
          '<button type="button" class="ghost-btn camera-cancel">Cancel</button>' +
          '<button type="button" class="primary-btn camera-capture">Capture</button>' +
          '<button type="button" class="ghost-btn camera-switch" title="Switch camera">Flip</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    video       = modal.querySelector("video");
    captureBtn  = modal.querySelector(".camera-capture");
    switchBtn   = modal.querySelector(".camera-switch");
    cancelBtn   = modal.querySelector(".camera-cancel");
    statusEl    = modal.querySelector(".camera-status");
    canvas      = document.createElement("canvas");

    captureBtn.addEventListener("click", capture);
    switchBtn.addEventListener("click", switchFacing);
    cancelBtn.addEventListener("click", () => closeWith(new Error("Capture cancelled.")));
    modal.querySelector(".camera-close").addEventListener("click", () => closeWith(new Error("Capture cancelled.")));
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeWith(new Error("Capture cancelled."));
    });
  }

  async function startStream() {
    setStatus("Starting camera...");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Camera API not supported in this browser.");
    }
    stopStream();
    const constraints = {
      audio: false,
      video: {
        facingMode: useFrontFacing ? "user" : { ideal: "environment" },
        width:  { ideal: 1920 },
        height: { ideal: 1080 }
      }
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play().catch(() => {/* some browsers throw on play() with no gesture; ignore */});
    setStatus("");
  }

  function stopStream() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
    if (statusEl) statusEl.style.display = msg ? "block" : "none";
  }

  async function switchFacing() {
    useFrontFacing = !useFrontFacing;
    try {
      await startStream();
    } catch (err) {
      setStatus("Could not switch camera: " + err.message);
    }
  }

  function capture() {
    if (!stream || !video.videoWidth) {
      setStatus("Camera is still warming up...");
      return;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    // Mirror horizontally if using front-facing camera so the saved image
    // matches what the user sees on screen.
    if (useFrontFacing) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);
    canvas.toBlob((blob) => {
      if (!blob) {
        closeWith(new Error("Failed to capture image."));
        return;
      }
      const file = new File([blob], buildFilename(), { type: "image/jpeg" });
      closeWith(null, file);
    }, "image/jpeg", 0.92);
  }

  function buildFilename() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return "capture_" + stamp + ".jpg";
  }

  function closeWith(err, file) {
    stopStream();
    if (modal) modal.classList.add("hidden");
    if (err) { rejectCapture && rejectCapture(err); }
    else     { resolveCapture && resolveCapture(file); }
    resolveCapture = rejectCapture = null;
  }

  /**
   * Open the camera modal. Returns a Promise<File>.
   */
  async function open() {
    ensureModal();
    modal.classList.remove("hidden");
    return new Promise(async (resolve, reject) => {
      resolveCapture = resolve;
      rejectCapture = reject;
      try {
        await startStream();
      } catch (err) {
        closeWith(new Error("Could not access the camera: " + err.message));
      }
    });
  }

  global.Camera = { open };
})(window);
