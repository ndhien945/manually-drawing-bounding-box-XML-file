"""Small web application for drawing and saving PASCAL VOC annotations."""

from __future__ import annotations

import os
from pathlib import Path
import re
from uuid import uuid4
import xml.etree.ElementTree as ET

from flask import Flask, jsonify, render_template, request, send_from_directory, url_for
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.exceptions import RequestEntityTooLarge


BASE_DIR = Path(__file__).resolve().parent
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
LABEL_PATTERN = re.compile(r"^[\w .-]{1,64}$", re.UNICODE)


def create_app(test_config: dict | None = None) -> Flask:
    app = Flask(__name__)
    app.config.from_mapping(
        MAX_CONTENT_LENGTH=16 * 1024 * 1024,
        ANNOTATION_FOLDER=BASE_DIR / "annotations",
    )
    if test_config:
        app.config.update(test_config)

    annotation_folder = Path(app.config["ANNOTATION_FOLDER"])
    annotation_folder.mkdir(parents=True, exist_ok=True)

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.post("/api/upload")
    def upload_image():
        uploaded_file = request.files.get("image")
        if uploaded_file is None or not uploaded_file.filename:
            return _error("Choose an image to upload.")

        original_name = _source_filename(uploaded_file.filename)
        extension = Path(original_name).suffix.lower()
        if not original_name or extension not in ALLOWED_EXTENSIONS:
            return _error("Use a JPG, JPEG, PNG, or WebP image.")

        image_path = annotation_folder / original_name
        temporary_path = annotation_folder / f".{uuid4().hex}{extension}"

        try:
            with Image.open(uploaded_file.stream) as source:
                source.load()
                normalized = ImageOps.exif_transpose(source)
                if normalized.mode not in {"RGB", "RGBA"}:
                    normalized = normalized.convert("RGB")

                save_format = {
                    ".jpg": "JPEG",
                    ".jpeg": "JPEG",
                    ".png": "PNG",
                    ".webp": "WEBP",
                }[extension]
                if save_format == "JPEG" and normalized.mode != "RGB":
                    normalized = normalized.convert("RGB")
                normalized.save(temporary_path, format=save_format)
                width, height = normalized.size
                depth = len(normalized.getbands())
            temporary_path.replace(image_path)
        except (UnidentifiedImageError, OSError, ValueError):
            temporary_path.unlink(missing_ok=True)
            return _error("The uploaded file is not a valid image.")

        return jsonify(
            {
                "filename": original_name,
                "storage_name": original_name,
                "url": url_for("annotation_image", filename=original_name),
                "width": width,
                "height": height,
                "depth": depth,
            }
        )

    @app.get("/annotation-images/<filename>")
    def annotation_image(filename: str):
        if Path(filename).suffix.lower() not in ALLOWED_EXTENSIONS:
            return _error("Image not found.", 404)
        return send_from_directory(annotation_folder, filename)

    @app.post("/api/annotations")
    def save_annotation():
        data = request.get_json(silent=True) or {}
        storage_name = _source_filename(str(data.get("storage_name", "")))
        filename = _source_filename(str(data.get("filename", "")))
        label = str(data.get("label", "number_plate")).strip()

        if not storage_name or storage_name != data.get("storage_name"):
            return _error("The uploaded image reference is invalid.")
        if filename != storage_name:
            return _error("The image filename does not match its stored name.")
        image_path = annotation_folder / storage_name
        if not image_path.is_file():
            return _error("Upload the image again before saving.", 404)
        if not filename or not LABEL_PATTERN.fullmatch(label):
            return _error("Enter a valid label (up to 64 characters).")

        try:
            with Image.open(image_path) as image:
                width, height = image.size
                depth = len(image.getbands())
        except (UnidentifiedImageError, OSError):
            return _error("The uploaded image can no longer be read.")

        bbox = data.get("bbox")
        if not isinstance(bbox, dict):
            return _error("Draw a bounding box before saving.")

        try:
            xmin = int(bbox["xmin"])
            ymin = int(bbox["ymin"])
            xmax = int(bbox["xmax"])
            ymax = int(bbox["ymax"])
        except (KeyError, TypeError, ValueError):
            return _error("Bounding-box coordinates must be whole numbers.")

        if not (0 <= xmin < xmax <= width and 0 <= ymin < ymax <= height):
            return _error(
                f"The bounding box must stay inside the {width} x {height} image."
            )

        xml_bytes = _build_pascal_voc_xml(
            filename=filename,
            image_path=image_path,
            width=width,
            height=height,
            depth=depth,
            label=label,
            bbox=(xmin, ymin, xmax, ymax),
        )
        stored_xml_name = f"{Path(filename).stem}.xml"
        (annotation_folder / stored_xml_name).write_bytes(xml_bytes)

        return jsonify(
            {
                "message": f"Saved {stored_xml_name}",
                "xml_name": stored_xml_name,
            }
        )

    @app.errorhandler(RequestEntityTooLarge)
    def image_too_large(_error_details):
        return _error("The image is larger than the 16 MB limit.", 413)

    return app


def _error(message: str, status: int = 400):
    return jsonify({"error": message}), status


def _source_filename(raw_name: str) -> str:
    """Return a safe basename while preserving the source image filename."""
    filename = str(raw_name).replace("\\", "/").rsplit("/", 1)[-1]
    if (
        not filename
        or filename in {".", ".."}
        or "\x00" in filename
        or any(ord(character) < 32 for character in filename)
    ):
        return ""
    return filename


def _build_pascal_voc_xml(
    *,
    filename: str,
    image_path: Path,
    width: int,
    height: int,
    depth: int,
    label: str,
    bbox: tuple[int, int, int, int],
) -> bytes:
    root = ET.Element("annotation")
    ET.SubElement(root, "folder").text = image_path.parent.name
    ET.SubElement(root, "filename").text = filename
    ET.SubElement(root, "path").text = str(image_path.resolve())

    source = ET.SubElement(root, "source")
    ET.SubElement(source, "database").text = "Unknown"

    size = ET.SubElement(root, "size")
    ET.SubElement(size, "width").text = str(width)
    ET.SubElement(size, "height").text = str(height)
    ET.SubElement(size, "depth").text = str(depth)
    ET.SubElement(root, "segmented").text = "0"

    object_element = ET.SubElement(root, "object")
    ET.SubElement(object_element, "name").text = label
    ET.SubElement(object_element, "pose").text = "Unspecified"
    ET.SubElement(object_element, "truncated").text = "0"
    ET.SubElement(object_element, "difficult").text = "0"

    box_element = ET.SubElement(object_element, "bndbox")
    for name, value in zip(("xmin", "ymin", "xmax", "ymax"), bbox):
        ET.SubElement(box_element, name).text = str(value)

    tree = ET.ElementTree(root)
    ET.indent(tree, space="\t")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


app = create_app()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "").lower() in {"1", "true", "yes"}
    app.run(host="127.0.0.1", port=port, debug=debug)
