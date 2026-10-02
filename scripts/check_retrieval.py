"""Report synthetic development-set source retrieval, not LLM answer accuracy."""
import json
from pathlib import Path

from tenderlens.config import Settings
from tenderlens.demo import seed_demo
from tenderlens.retrieval import Retriever
from tenderlens.store import Store


def main():
    root = Path(__file__).resolve().parents[1]
    settings = Settings()
    store = Store(settings.data_dir)
    package = seed_demo(store, settings)
    retriever = Retriever(settings)
    dataset = json.loads((root / "datasets/synthetic-development.json").read_text("utf-8"))
    rows = []
    for example in dataset["questions"]:
        evidence, warnings = retriever.search(store.evidence(package["id"]), example["question"])
        found = {item["document_name"] for item in evidence}
        rows.append({
            "question_id": example["id"],
            "required_source_documents_found": set(example["required_documents"]).issubset(found),
            "retrieved": sorted(found), "warnings": warnings,
        })
    report = {
        "dataset": dataset["dataset_id"], "retrieval_mode": settings.retrieval_mode,
        "notice": "Synthetic development source coverage only. No generated answers were evaluated.",
        "results": rows,
    }
    path = root / "data/retrieval-development-report.json"
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    print(f"Saved {path}")


if __name__ == "__main__":
    main()
