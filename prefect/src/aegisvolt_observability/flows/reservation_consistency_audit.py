"""reservation_consistency_audit: reservas huérfanas o que bloquean conectores sin motivo
(reglas RES-001 a RES-005)."""

from __future__ import annotations

from prefect import flow
from prefect.logging import get_run_logger

from ..model import RESERVATION_ACTIVE, Fetched, Saga, Session
from ..reporting import AuditReport, publish
from ..rules import older_than
from ..rules import reservations as rules
from ..tasks import fetch_saga, fetch_session, list_fleet_reservations, publish_metrics
from .common import context, discover_fleets


@flow(name="reservation_consistency_audit")
def reservation_consistency_audit(
    environment: str = "dev", fleets: list[str] | None = None, lookback_hours: int | None = None
) -> AuditReport:
    """Recorre las reservas de cada flota (station-reservation) creadas en la ventana y
    contrasta las activas con su SAGA (orquestador) y su sesión (energy-dispatch)."""
    logger = get_run_logger()
    ctx = context(environment, lookback_hours)
    report = AuditReport("reservation_consistency_audit", environment, ctx.correlation_id, ctx.now, rules.RULES)
    audit = ctx.settings.audit
    fleet_ids = fleets or discover_fleets(ctx)
    report.scanned["flotas"] = len(fleet_ids)

    listed = [
        list_fleet_reservations.submit(
            ctx.url("station_reservation"),
            fleet,
            ctx.since,
            audit.page_limit,
            audit.max_pages,
            ctx.timeout,
            ctx.correlation_id,
        )
        for fleet in fleet_ids
    ]
    reservations = [r for future in listed for r in future.result()]
    report.scanned["reservas"] = len(reservations)
    # Solo las activas y estables pueden infringir una regla: se consultan sus SAGAs.
    active = [
        r
        for r in reservations
        if r.status in RESERVATION_ACTIVE and older_than(r.updated_at, ctx.now, ctx.thresholds.settle_seconds)
    ]
    report.scanned["reservas_activas"] = len(active)
    saga_futures = {
        sid: fetch_saga.submit(ctx.url("saga_orchestrator"), sid, ctx.timeout, ctx.correlation_id)
        for sid in {r.saga_id for r in active}
    }

    for reservation in active:
        try:
            saga: Fetched[Saga] = saga_futures[reservation.saga_id].result()
            session: Fetched[Session] | None = None
            if rules.needs_session(reservation) and saga.value is not None:
                session = fetch_session(
                    ctx.url("energy_dispatch"), saga.value.session_id, ctx.timeout, ctx.correlation_id
                )
        except Exception as error:  # noqa: BLE001 - se informa como no evaluado
            report.errors.append(f"Reserva {reservation.reservation_id}: no consultable ({error})")
            continue
        report.findings += rules.evaluate_reservation(reservation, saga, session, ctx.now, ctx.thresholds)

    for finding in report.findings:
        logger.warning(finding.explanation())
    logger.info(
        "%d reservas (%d activas) en %d flotas, %d hallazgos",
        len(reservations),
        len(active),
        len(fleet_ids),
        len(report.findings),
    )
    publish(report)
    publish_metrics(ctx.settings.cloudwatch, report.metrics())
    return report
