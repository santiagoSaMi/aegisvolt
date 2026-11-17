"""billing_consistency_audit: débitos sin sesión, reembolsos pendientes y anomalías del
libro mayor (reglas BIL-001 a BIL-006)."""

from __future__ import annotations

from prefect import flow
from prefect.logging import get_run_logger

from ..model import Debit, Fetched, LedgerEntry, Saga, Session
from ..reporting import AuditReport, publish
from ..rules import billing as rules
from ..tasks import fetch_debit, fetch_saga, fetch_session, list_fleet_ledger, publish_metrics
from .common import context, discover_fleets


@flow(name="billing_consistency_audit")
def billing_consistency_audit(
    environment: str = "dev", fleets: list[str] | None = None, lookback_hours: int | None = None
) -> AuditReport:
    """Recorre el libro mayor de cada flota (billing-wallet) en la ventana, consulta cada
    débito y lo contrasta con su SAGA (orquestador) y su sesión (energy-dispatch)."""
    logger = get_run_logger()
    ctx = context(environment, lookback_hours)
    report = AuditReport("billing_consistency_audit", environment, ctx.correlation_id, ctx.now, rules.RULES)
    audit = ctx.settings.audit
    fleet_ids = fleets or discover_fleets(ctx)
    report.scanned["flotas"] = len(fleet_ids)

    ledgers = {
        fleet: list_fleet_ledger.submit(
            ctx.url("billing_wallet"),
            fleet,
            ctx.since,
            audit.page_limit,
            audit.max_pages,
            ctx.timeout,
            ctx.correlation_id,
        )
        for fleet in fleet_ids
    }
    entries: list[LedgerEntry] = [e for future in ledgers.values() for e in future.result()]
    report.scanned["movimientos"] = len(entries)
    debit_ids = sorted({e.debit_id for e in entries if e.debit_id and e.type in {"DEBIT", "REFUND"}})
    report.scanned["debitos"] = len(debit_ids)

    debit_futures = {
        d: fetch_debit.submit(ctx.url("billing_wallet"), d, ctx.timeout, ctx.correlation_id) for d in debit_ids
    }
    debits: dict[str, Debit] = {}
    for debit_id, future in debit_futures.items():
        try:
            fetched = future.result()
        except Exception as error:  # noqa: BLE001
            report.errors.append(f"Débito {debit_id}: no consultable ({error})")
            continue
        if fetched.value is not None:
            debits[debit_id] = fetched.value

    saga_futures = {
        sid: fetch_saga.submit(ctx.url("saga_orchestrator"), sid, ctx.timeout, ctx.correlation_id)
        for sid in {d.saga_id for d in debits.values()}
    }
    for debit in debits.values():
        try:
            saga: Fetched[Saga] = saga_futures[debit.saga_id].result()
            session: Fetched[Session] | None = None
            if rules.needs_session(debit, saga) and saga.value is not None:
                session = fetch_session(
                    ctx.url("energy_dispatch"), saga.value.session_id, ctx.timeout, ctx.correlation_id
                )
        except Exception as error:  # noqa: BLE001
            report.errors.append(f"Débito {debit.debit_id}: SAGA o sesión no consultable ({error})")
            continue
        report.findings += rules.evaluate_debit(debit, saga, session, ctx.now, ctx.thresholds)
    report.findings += rules.duplicated_refunds(entries, debits)

    for finding in report.findings:
        logger.warning(finding.explanation())
    logger.info("%d débitos en %d flotas, %d hallazgos", len(debits), len(fleet_ids), len(report.findings))
    publish(report)
    publish_metrics(ctx.settings.cloudwatch, report.metrics())
    return report
