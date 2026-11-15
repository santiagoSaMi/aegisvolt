"""saga_consistency_audit: SAGAs detenidas, compensaciones fallidas y SAGAs terminadas
que contradicen el estado de su carga (reglas SAGA-001 a SAGA-005)."""

from __future__ import annotations

from datetime import datetime, timedelta

from prefect import flow
from prefect.logging import get_run_logger

from ..model import SAGA_IN_PROGRESS, Fetched, Saga, Session
from ..reporting import AuditReport, publish
from ..rules import saga as rules
from ..tasks import fetch_session, list_sagas_by_status, publish_metrics
from .common import AuditContext, context


def _candidates(ctx: AuditContext) -> list[Saga]:
    """Solo lo que alguna regla puede marcar, con consultas por estado (índice del orquestador):
    - en curso sin cambios desde antes de `stale_after` (SAGA-001);
    - COMPENSATION_FAILED, sin límite de antigüedad (SAGA-002/003);
    - terminadas en la ventana y estables (SAGA-004/005)."""
    audit, t = ctx.settings.audit, ctx.thresholds
    url = ctx.url("saga_orchestrator")
    stale_before = ctx.now - timedelta(seconds=t.stale_after_seconds)
    settled_before = ctx.now - timedelta(seconds=t.settle_seconds)
    queries: list[tuple[str, datetime | None, datetime | None]] = [
        (s, None, stale_before) for s in sorted(SAGA_IN_PROGRESS)
    ]
    queries.append(("COMPENSATION_FAILED", None, None))
    queries += [(s, ctx.since, settled_before) for s in ("COMPLETED", "COMPENSATED", "FAILED")]
    futures = [
        list_sagas_by_status.submit(
            url, status, after, before, audit.page_limit, audit.max_pages, ctx.timeout, ctx.correlation_id
        )
        for status, after, before in queries
    ]
    return [saga for future in futures for saga in future.result()]


@flow(name="saga_consistency_audit")
def saga_consistency_audit(environment: str = "dev", lookback_hours: int | None = None) -> AuditReport:
    logger = get_run_logger()
    ctx = context(environment, lookback_hours)
    report = AuditReport("saga_consistency_audit", environment, ctx.correlation_id, ctx.now, rules.RULES)
    sagas = _candidates(ctx)
    report.scanned["sagas"] = len(sagas)

    sessions = {
        saga.saga_id: fetch_session.submit(ctx.url("energy_dispatch"), saga.session_id, ctx.timeout, ctx.correlation_id)
        for saga in sagas
        if rules.needs_session(saga)
    }
    for saga in sagas:
        session: Fetched[Session] | None = None
        if saga.saga_id in sessions:
            try:
                session = sessions[saga.saga_id].result()
            except Exception as error:  # noqa: BLE001 - se informa como no evaluado
                report.errors.append(f"SAGA {saga.saga_id}: sesión no consultable ({error})")
                continue
        report.findings += rules.evaluate_saga(saga, session, ctx.now, ctx.thresholds)

    for finding in report.findings:
        logger.warning(finding.explanation())
    logger.info(
        "%d SAGAs revisadas, %d hallazgos, %d sin evaluar", len(sagas), len(report.findings), len(report.errors)
    )
    publish(report)
    publish_metrics(ctx.settings.cloudwatch, report.metrics())
    return report
