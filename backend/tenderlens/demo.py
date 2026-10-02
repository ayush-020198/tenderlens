import io
import json
from importlib.resources import files
from threading import Lock
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from .config import Settings
from .documents import ingest
from .store import Store

DEMO_LOCK = Lock()


def make_pdf(pages: list[dict]) -> bytes:
    output = io.BytesIO()
    document = SimpleDocTemplate(
        output, pagesize=A4, topMargin=18 * mm, bottomMargin=18 * mm,
        leftMargin=18 * mm, rightMargin=18 * mm,
    )
    styles = getSampleStyleSheet()
    styles["BodyText"].fontSize = 10
    styles["BodyText"].leading = 15
    story = []
    for index, page in enumerate(pages):
        if index:
            story.append(PageBreak())
        story.append(Paragraph(escape(page["title"]), styles["Title"]))
        story.append(Spacer(1, 8 * mm))
        for paragraph in page["text"].split("\n\n"):
            story.append(Paragraph(escape(paragraph).replace("\n", "<br/>"), styles["BodyText"]))
            story.append(Spacer(1, 3 * mm))
        if page.get("table"):
            rows = [[Paragraph(escape(cell), styles["BodyText"]) for cell in row] for row in page["table"]]
            table = Table(rows, colWidths=[13 * mm, 72 * mm, 20 * mm, 25 * mm, 39 * mm])
            table.setStyle(TableStyle([
                ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                ("BACKGROUND", (0, 0), (-1, 0), colors.whitesmoke),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]))
            story.append(table)
            story.append(Spacer(1, 4 * mm))
            story.append(Paragraph(escape(page.get("footnote", "")), styles["BodyText"]))
    document.build(story)
    return output.getvalue()


def seed_demo(store: Store, settings: Settings) -> dict:
    with DEMO_LOCK:
        for package in store.packages():
            if package["demo_key"] == "india-v1":
                return package
        content = json.loads(files("tenderlens").joinpath("data/demo.json").read_text("utf-8"))
        package = store.create_package(content["name"], content["reference"], "india-v1")
        saved = []
        try:
            for item in content["documents"]:
                amendment = saved[item["amends_index"]]["id"] if "amends_index" in item else None
                saved.append(ingest(
                    store, settings, package["id"], item["name"], make_pdf(item["pages"]),
                    item["kind"], item["issued_on"], amendment,
                ))
        except BaseException:
            # A failed seed must be retryable, not a success-shaped empty demo.
            with store.connect() as db:
                db.execute("UPDATE packages SET demo_key=NULL WHERE id=?", (package["id"],))
            raise
        return package
