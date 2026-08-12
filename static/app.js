(() => {
  "use strict";

  const IMAGE_EXTENSION = /\.(jpe?g|png|webp)$/i;
  const uploadForm = document.querySelector("#upload-form");
  const imageInput = document.querySelector("#image-input");
  const folderInput = document.querySelector("#folder-input");
  const folderButton = document.querySelector("#folder-button");
  const dropZone = document.querySelector("#drop-zone");
  const uploadLabel = document.querySelector("#upload-label");
  const editor = document.querySelector("#editor");
  const emptyState = document.querySelector("#empty-state");
  const batchProgress = document.querySelector("#batch-progress");
  const queueCount = document.querySelector("#queue-count");
  const currentFilename = document.querySelector("#current-filename");
  const progressFill = document.querySelector("#progress-fill");
  const previousButton = document.querySelector("#previous-button");
  const nextButton = document.querySelector("#next-button");
  const sourceImage = document.querySelector("#source-image");
  const canvas = document.querySelector("#annotation-canvas");
  const context = canvas.getContext("2d");
  const clearButton = document.querySelector("#clear-button");
  const saveButton = document.querySelector("#save-button");
  const saveLabel = document.querySelector("#save-label");
  const classLabel = document.querySelector("#class-label");
  const status = document.querySelector("#status");
  const coordinateInputs = Object.fromEntries(
    ["xmin", "ymin", "xmax", "ymax"].map((name) => [name, document.querySelector(`#${name}`)])
  );

  let queue = [];
  let currentIndex = -1;
  let box = null;
  let startPoint = null;
  let drawing = false;
  let busy = false;

  function currentItem() {
    return queue[currentIndex] || null;
  }

  function setStatus(message = "", type = "") {
    status.textContent = message;
    status.className = `status${type ? ` is-${type}` : ""}`;
  }

  function setBusy(value) {
    busy = value;
    imageInput.disabled = value;
    folderInput.disabled = value;
    folderButton.disabled = value;
    updateControls();
  }

  function updateControls() {
    const item = currentItem();
    const savedCount = queue.filter((entry) => entry.saved).length;
    const hasItem = Boolean(item);

    batchProgress.hidden = !hasItem;
    if (hasItem) {
      queueCount.textContent = `Image ${currentIndex + 1} of ${queue.length} · ${savedCount} saved`;
      currentFilename.textContent = item.displayName;
      progressFill.style.width = `${((currentIndex + 1) / queue.length) * 100}%`;
      previousButton.disabled = busy || currentIndex === 0;
      nextButton.disabled = busy || currentIndex >= queue.length - 1;
      nextButton.textContent = item.saved ? "Next image →" : "Skip image →";
      saveLabel.textContent = currentIndex < queue.length - 1 ? "Save XML & Next" : "Save XML";
    }
    saveButton.disabled = busy || !isValidBox(box) || !classLabel.value.trim();
    clearButton.disabled = busy || !hasItem;
  }

  function pointFromEvent(event) {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: Math.round(Math.max(0, Math.min(canvas.width, (event.clientX - bounds.left) * canvas.width / bounds.width))),
      y: Math.round(Math.max(0, Math.min(canvas.height, (event.clientY - bounds.top) * canvas.height / bounds.height)))
    };
  }

  function normalizedBox(first, second) {
    return {
      xmin: Math.min(first.x, second.x),
      ymin: Math.min(first.y, second.y),
      xmax: Math.max(first.x, second.x),
      ymax: Math.max(first.y, second.y)
    };
  }

  function isValidBox(value) {
    return value && value.xmax > value.xmin && value.ymax > value.ymin;
  }

  function rememberBox() {
    const item = currentItem();
    if (item) item.box = box ? { ...box } : null;
  }

  function updateCoordinates() {
    for (const [name, input] of Object.entries(coordinateInputs)) {
      input.value = box ? box[name] : "";
    }
    updateControls();
  }

  function draw() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!isValidBox(box)) return;

    const width = box.xmax - box.xmin;
    const height = box.ymax - box.ymin;
    const lineWidth = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) / 280));

    context.save();
    context.fillStyle = "rgba(238, 104, 74, 0.13)";
    context.strokeStyle = "#ff6849";
    context.lineWidth = lineWidth;
    context.setLineDash([lineWidth * 3, lineWidth * 2]);
    context.fillRect(box.xmin, box.ymin, width, height);
    context.strokeRect(box.xmin, box.ymin, width, height);

    const label = `${width} × ${height}`;
    const fontSize = Math.max(12, Math.round(Math.min(canvas.width, canvas.height) / 48));
    context.font = `700 ${fontSize}px system-ui, sans-serif`;
    const labelWidth = context.measureText(label).width + fontSize;
    const labelY = box.ymin > fontSize * 2 ? box.ymin - fontSize * 1.8 : box.ymin;
    context.setLineDash([]);
    context.fillStyle = "#ff6849";
    context.fillRect(box.xmin, labelY, labelWidth, fontSize * 1.8);
    context.fillStyle = "#ffffff";
    context.fillText(label, box.xmin + fontSize / 2, labelY + fontSize * 1.3);
    context.restore();
  }

  function clearBox() {
    box = null;
    startPoint = null;
    drawing = false;
    rememberBox();
    updateCoordinates();
    draw();
    setStatus(currentItem() ? "Drag on the image to create a box." : "");
  }

  async function uploadItem(item) {
    const formData = new FormData();
    formData.append("image", item.file);
    const response = await fetch("/api/upload", { method: "POST", body: formData });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Upload failed.");
    item.imageData = result;
  }

  async function showCurrent(prefix = "") {
    const item = currentItem();
    if (!item) return;

    setBusy(true);
    box = item.box ? { ...item.box } : null;
    updateCoordinates();
    setStatus(`Loading ${item.displayName}…`);

    try {
      if (!item.imageData) await uploadItem(item);
      sourceImage.src = item.imageData.url;
      await sourceImage.decode();
      canvas.width = item.imageData.width;
      canvas.height = item.imageData.height;
      editor.hidden = false;
      emptyState.hidden = true;
      draw();

      const details = `${item.imageData.width} × ${item.imageData.height} pixels`;
      setStatus(prefix ? `${prefix} Now annotating ${item.displayName} · ${details}` : `${item.displayName} · ${details}`,
        prefix ? "success" : "");
      editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      item.error = error.message;
      setStatus(`${item.displayName}: ${error.message}`, "error");
      if (currentIndex < queue.length - 1) {
        currentIndex += 1;
        await showCurrent(`Skipped unreadable image.`);
        return;
      }
    } finally {
      setBusy(false);
      updateCoordinates();
    }
  }

  async function startQueue(fileList) {
    if (busy) return;
    const files = Array.from(fileList)
      .filter((file) => IMAGE_EXTENSION.test(file.name))
      .sort((left, right) => {
        const leftName = left.webkitRelativePath || left.name;
        const rightName = right.webkitRelativePath || right.name;
        return leftName.localeCompare(rightName, undefined, { numeric: true, sensitivity: "base" });
      });

    if (!files.length) {
      setStatus("No supported images were found. Choose JPG, PNG, or WebP files.", "error");
      return;
    }

    queue = files.map((file) => ({
      file,
      displayName: file.webkitRelativePath || file.name,
      imageData: null,
      box: null,
      saved: false,
      error: null
    }));
    currentIndex = 0;
    uploadLabel.textContent = files.length === 1 ? files[0].name : `${files.length} images selected`;
    await showCurrent(files.length > 1 ? `Folder queue ready with ${files.length} images.` : "");
  }

  async function goTo(index, prefix = "") {
    if (busy || index < 0 || index >= queue.length || index === currentIndex) return;
    rememberBox();
    currentIndex = index;
    await showCurrent(prefix);
  }

  uploadForm.addEventListener("submit", (event) => event.preventDefault());
  imageInput.addEventListener("change", () => {
    const files = Array.from(imageInput.files);
    imageInput.value = "";
    startQueue(files);
  });
  folderButton.addEventListener("click", () => folderInput.click());
  folderInput.addEventListener("change", () => {
    const files = Array.from(folderInput.files);
    folderInput.value = "";
    startQueue(files);
  });

  for (const eventName of ["dragenter", "dragover"]) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove("is-dragging");
    });
  }
  dropZone.addEventListener("drop", (event) => startQueue(event.dataTransfer.files));

  previousButton.addEventListener("click", () => goTo(currentIndex - 1));
  nextButton.addEventListener("click", () => goTo(currentIndex + 1, "Skipped previous image."));

  canvas.addEventListener("pointerdown", (event) => {
    if (!currentItem()?.imageData || busy) return;
    canvas.setPointerCapture(event.pointerId);
    startPoint = pointFromEvent(event);
    box = normalizedBox(startPoint, startPoint);
    drawing = true;
    rememberBox();
    updateCoordinates();
    draw();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!drawing) return;
    box = normalizedBox(startPoint, pointFromEvent(event));
    rememberBox();
    updateCoordinates();
    draw();
  });

  function finishDrawing(event) {
    if (!drawing) return;
    box = normalizedBox(startPoint, pointFromEvent(event));
    drawing = false;
    if (!isValidBox(box)) box = null;
    rememberBox();
    updateCoordinates();
    draw();
    setStatus(box ? "Box ready. Save it to continue." : "Drag a larger box on the image.");
  }
  canvas.addEventListener("pointerup", finishDrawing);
  canvas.addEventListener("pointercancel", () => {
    drawing = false;
    if (!isValidBox(box)) box = null;
    rememberBox();
    updateCoordinates();
    draw();
  });

  classLabel.addEventListener("input", updateCoordinates);
  clearButton.addEventListener("click", clearBox);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && box) clearBox();
  });

  saveButton.addEventListener("click", async () => {
    const item = currentItem();
    if (!item?.imageData || !isValidBox(box) || busy) return;
    setBusy(true);
    setStatus(`Saving ${item.imageData.filename}…`);

    try {
      const response = await fetch("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storage_name: item.imageData.storage_name,
          filename: item.imageData.filename,
          label: classLabel.value.trim(),
          bbox: box
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save the annotation.");

      item.saved = true;

      if (currentIndex < queue.length - 1) {
        currentIndex += 1;
        await showCurrent(`${result.message}.`);
        return;
      }

      const savedCount = queue.filter((entry) => entry.saved).length;
      const message = savedCount === queue.length
        ? `Batch complete — all ${savedCount} annotations are saved.`
        : `${result.message}. ${savedCount} of ${queue.length} images are saved; use Previous to finish skipped images.`;
      setStatus(message, "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setBusy(false);
      updateControls();
    }
  });
})();
