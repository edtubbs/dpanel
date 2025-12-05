import {
  LitElement,
  html,
  css,
  nothing,
  choose,
  unsafeHTML,
  classMap,
} from "/vendor/@lit/all@3.1.2/lit-all.min.js";
import "/components/common/action-row/action-row.js";
import "/components/common/dynamic-form/dynamic-form.js";
import "/components/views/x-check/index.js";
import "/components/common/page-container.js";
import "/components/common/sparkline-chart/sparkline-chart-v2.js";
import "/components/views/x-metric/metric.js";
import "/components/views/x-activity-log.js";
import "/components/common/reveal-row/reveal-row.js";
import "/components/views/x-version-card.js";
import "/components/views/x-launcher-button/index.js";
import "/components/views/x-log-viewer/index.js";
import { bindToClass } from "/utils/class-bind.js";
import * as renderMethods from "./renders/index.js";
import { store } from "/state/store.js";
import { StoreSubscriber } from "/state/subscribe.js";
import { pkgController } from "/controllers/package/index.js";
import { asyncTimeout } from "/utils/timeout.js";
import { createAlert } from "/components/common/alert.js";
import { doBootstrap } from "/api/bootstrap/bootstrap.js";
import { renderDialog } from "./renders/dialog.js";
import { renderActions } from "./renders/actions.js";
import { renderStatus } from "./renders/status.js";

class PupPage extends LitElement {
  static get properties() {
    return {
      ready: { type: Boolean }, // Page is loading or not.
      result: { type: String }, // 200, 404, 500.
      open_dialog: { type: Boolean },
      open_dialog_label: { type: String },
      checks: { type: Object },
      pupEnabled: { type: Boolean },
      _confirmedName: { type: String },
      inflight_startstop: { type: Boolean },
      inflight_uninstall: { type: Boolean },
      inflight_purge: { type: Boolean },
      _HARDCODED_UNINSTALL_WAIT_TIME: { type: Number },
      activityLogs: { type: Array },
    };
  }

  constructor() {
    super();
    bindToClass(renderMethods, this);
    this.pkgController = pkgController;
    this.context = new StoreSubscriber(this, store);
    this.open_dialog = "";
    this.open_dialog_label = "";
    this.open_page = false;
    this.open_page_label = "";
    this.checks = [];
    this.pupEnabled = false;
    this._confirmedName = "";
    this._HARDCODED_UNINSTALL_WAIT_TIME = 0;
    this.activityLogs = [];
    this.renderDialog = renderDialog.bind(this);
    this.renderActions = renderActions.bind(this);
    this.renderStatus = renderStatus.bind(this);
  }

  getPup() {
    return this.pkgController.getPupMaster({
      pupId: this.context.store.pupContext?.state?.id,
      lookupType: "byStatePupId",
    }).pup;
  }

  _attachMetadata(metrics) {
    if (!Array.isArray(metrics) || !metrics.length) return metrics || [];

    const pickTs = (obj) => {
      if (!obj || typeof obj !== "object") return null;
      const keys = ["ts", "time", "timestamp", "date", "t"];
      for (const k of keys) {
        const v = obj[k];
        if (v !== null && v !== undefined && String(v) !== "") return v;
      }
      // common meta shape from monitor.go
      if (obj.sample_ts !== null && obj.sample_ts !== undefined) return obj.sample_ts;
      return null;
    };

    const txMetric = metrics.find((m) => m && m.name === "metadata");
    if (!txMetric || !Array.isArray(txMetric.values) || !txMetric.values.length) {
      return metrics;
    }

    // Normalize metadata series into points: [{ ts, metaStr }...]
    const txPoints = txMetric.values
      .map((raw, i) => {
        let metaObj = null;
        let v = raw;

        if (Array.isArray(raw) && raw.length >= 2) {
          // [ts, value]
          const ts = raw[0];
          const val = raw[1];
          const metaStr = val == null ? "" : String(val);
          return { ts, metaStr, idx: i };
        }

        if (raw && typeof raw === "object") {
          metaObj = raw.meta && typeof raw.meta === "object" ? raw.meta : null;
          const key = ["value", "v", "n", "val", "y", "x"].find((k) => raw[k] != null);
          v = key ? raw[key] : raw;
        }

        const ts = pickTs(raw) ?? pickTs(metaObj);
        // Prefer meta.txid if present; else fall back to the value itself.
        const txid = metaObj?.txid != null ? String(metaObj.txid) : (v == null ? "" : String(v));
        return { ts, metaStr: txid, idx: i };
      })
      .filter((p) => p && p.metaStr);

    const hasTxTs = txPoints.some((p) => p.ts !== null && p.ts !== undefined && String(p.ts) !== "");

    // Only attach to numeric chart series (prevents turning string tiles into [object Object]).
    const wantsTx = (m) =>
      m &&
      m.type === "float" &&
      typeof m.name === "string" &&
      (m.name.startsWith("smpv_") || m.name.startsWith("stats_"));

    const findClosestByTs = (ts) => {
      if (!hasTxTs || ts == null || ts === "") return null;

      // Compare as numbers when possible (seconds vs ms is OK for "closest" within a small window).
      const toNum = (x) => {
        const n = Number(x);
        return Number.isFinite(n) ? n : null;
      };

      const target = toNum(ts);
      if (target == null) return null;

      let best = null;
      let bestDist = Infinity;

      for (const p of txPoints) {
        const pn = toNum(p.ts);
        if (pn == null) continue;
        const d = Math.abs(pn - target);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }

      return best;
    };

    return metrics.map((m) => {
      if (!m) return m;
      if (m.name === "metadata") return m;
      if (!wantsTx(m)) return m;
      if (!Array.isArray(m.values) || !m.values.length) return m;

      const newVals = m.values.map((raw, i) => {
        // figure out this sample's timestamp if it exists
        let ts = null;

        if (Array.isArray(raw) && raw.length >= 2) {
          ts = raw[0];
        } else if (raw && typeof raw === "object") {
          ts = pickTs(raw) ?? pickTs(raw.meta);
        }

        const closest = ts != null ? findClosestByTs(ts) : null;
        const metaStr = closest?.metaStr || txPoints[i]?.metaStr || "";

        // preserve incoming shape but ensure sparkline sees { value, ts, metadata }
        if (Array.isArray(raw) && raw.length >= 2) {
          return { value: raw[1], ts: raw[0], metadata: metaStr };
        }

        if (raw && typeof raw === "object") {
          const key = ["value", "v", "n", "val", "y", "x"].find((k) => raw[k] != null);
          const val = key ? raw[key] : raw.value ?? raw;
          const out = { ...raw, value: val, metadata: metaStr };
          if (ts != null) out.ts = ts;
          return out;
        }

        // primitive number
        const out = { value: raw, metadata: metaStr };
        if (ts != null) out.ts = ts;
        return out;
      });

      return { ...m, values: newVals };
    });
  }

  connectedCallback() {
    super.connectedCallback();
    this.pkgController.addObserver(this);
  }

  disconnectedCallback() {
    this.pkgController.removeObserver(this);
    super.disconnectedCallback();
  }

  requestUpdate(options = {}) {
    if (this.pkgController && options.type === "activity") {
      if (this.context.store.pupContext?.state?.id) {
        this.updateActivityLogs();
      }
    }
    super.requestUpdate();
  }

  updateActivityLogs() {
    const pupId = this.context.store.pupContext?.state?.id;
    this.activityLogs = [...this.pkgController.activityIndex[pupId]];
  }

  async firstUpdated() {
    this.addEventListener("sl-hide", this.handleDialogClose);
  }

  handleDialogClose() {
    this.clearDialog();
  }

  clearDialog() {
    this.open_dialog = false;
    this.open_dialog_label = "";
  }

  handleMenuClick = (event, el) => {
    this.open_dialog = el.getAttribute("name");
    this.open_dialog_label = el.getAttribute("label");
  };

  submitConfig = async (stagedChanges, formNode, dynamicForm) => {
    // Define callbacks
    const pupId = this.context.store.pupContext.state.id
    const callbacks = {
      onSuccess: () => dynamicForm.commitChanges(formNode),
      onError: (errorPayload) => {
        dynamicForm.retainChanges();
        this.displayConfigUpdateErr(errorPayload);
      },
    };

    const res = await pkgController.requestPupChanges(
      pupId,
      stagedChanges,
      callbacks,
    );
    if (res && !res.error) {
      return true;
    }
  };

  displayConfigUpdateErr(failedTxnPayload) {
    const failedTxnId = failedTxnPayload?.id ? `(${failedTxnPayload.id})` : "";
    const message = [
      "Failed to update configuration",
      `Refer to logs ${failedTxnId}`,
    ];
    const action = { text: "View details" };
    const err = new Error(failedTxnPayload.error);
    const hideAfter = 0;

    createAlert(
      "danger",
      message,
      "exclamation-diamond",
      hideAfter,
      action,
      err,
    );
  }

  async handleStartStop(e) {
    const pupId = this.context.store.pupContext.state.id;
    this.inflight_startstop = true;
    this.pupEnabled = e.target.checked;
    this.requestUpdate();

    const actionName = e.target.checked ? "start" : "stop";
    const callbacks = {
      onSuccess: () => {
        this.inflight_startstop = false;
      },
      onError: () => {
        console.warning("Txn reported an error");
        this.inflight_startstop = false;
      },
      onTimeout: () => {
        console.log(
          "Slow txn, no repsonse within ~30 seconds (start/stop)",
        );
        this.inflight_startstop = false;
      },
    };
    await this.pkgController.requestPupAction(pupId, actionName, callbacks);
  }

  async handleUninstall(e) {
    const pupId = this.context.store.pupContext.state.id;
    this.pupEnabled = false;
    this.inflight_uninstall = true;
    this.requestUpdate();

    const actionName = "uninstall";
    const callbacks = {
      onSuccess: async () => {
        await doBootstrap();
        this.inflight_uninstall = false;
      },
      onError: async () => {
        await doBootstrap();
        this.inflight_uninstall = false;
      },
      onTimeout: async () => {
        await doBootstrap();
        this.inflight_uninstall = false;
      },
    };
    await this.pkgController.requestPupAction(pupId, actionName, callbacks);
    this._HARDCODED_UNINSTALL_WAIT_TIME = 15000;

    this._confirmedName = "";
    this.clearDialog();
  }

  render() {
    const pupContext = this.context.store?.pupContext;

    if (!pupContext.ready) {
      return html`
        <div id="PageWrapper" class="wrapper">
          <section>
            <div class="section-title">
              <h3>
                Status &nbsp;<sl-spinner
                  style="position: relative; top: 3px;"
                ></sl-spinner>
              </h3>
            </div>
          </section>
        </div>
      `;
    }

    if (pupContext.result !== 200) {
      return html`
        <div id="PageWrapper" class="wrapper">
          <section>
            <div class="section-title">
              <h3>Such Empty</h3>
              <p>Nothing to see here</p>
            </div>
          </section>
        </div>
      `;
    }

    const path = this.context.store?.appContext?.path || [];
    const pkg = this.getPup();

    if (!pkg) return;

    const hasChecks = (pkg.state.manifest?.checks || []).length > 0;

    let labels = pkg?.computed || {};
    let isInstallationLoadingStatus = ["uninstalling", "purging"].includes(
      labels.installationId,
    );
    let statusInstallationId =
      labels.installationId === "ready"
        ? labels.statusId
        : labels.installationId;
    const isLoadingStatus = ["starting", "stopping"].includes(labels.statusId);
    const disableActions = labels.installationId === "uninstalled";
    const isRunning = labels.statusId === "running";

    const short = pkg?.state?.manifest?.meta?.shortDescription || "";
    const long = pkg?.state?.manifest?.meta?.longDescription || "";

    const logo = pkg?.assets?.logos?.mainLogoBase64;

    if (this._HARDCODED_UNINSTALL_WAIT_TIME) {
      isInstallationLoadingStatus = true;
      labels.installationId = "uninstalling";
      labels.installationLabel = "uninstalling";
      statusInstallationId = "uninstalling";
      setTimeout(() => {
        this._HARDCODED_UNINSTALL_WAIT_TIME = 0;
        doBootstrap();
      }, this._HARDCODED_UNINSTALL_WAIT_TIME);
    }

    const renderHealthChecks = () => {
      return this.checks.map(
        (check) => html`
          <health-check
            status=${check.status}
            .check=${check}
            ?disabled=${!this.pupEnabled || disableActions}
          ></health-check>
        `,
      );
    };

    const renderStats = () => {
      if (pkg.stats.metrics.length === 0) {
        return html`
          <div class="metrics-wrap">
            <small
              style="font-family: 'Comic Neue'; color: var(--sl-color-neutral-600);"
              >Such empty. Pup reports no metrics</small
            >
          </div>
        `;
      }

      const manifestList = pkg.state.manifest?.metrics ?? [];

      const defsByName = new Map(
        manifestList
          .filter((m) => m.name?.trim())
          .map((m) => [String(m.name).trim().toLowerCase(), m]),
      );

      const enriched = (pkg.stats.metrics || []).map((m) => {
        const matchedDef = defsByName.get(
          String(m.name || "").trim().toLowerCase(),
        );
        const desc = matchedDef?.description?.trim?.() || "";
        return { ...m, description: desc };
      });

      const withTx = this._attachMetadata(enriched);

      // hide metadata series from the grid, but keep it available for tooltips
      const visibleMetrics = withTx.filter(
        (metric) => metric && metric.name !== "metadata",
      );

      return html`
        <div class="metrics-wrap">
          ${visibleMetrics.map(
            (metric) => html`
              <div class="metric-container">
                <div
                  class="metric-label"
                  title=${(metric.description ||
                  metric.label ||
                  metric.name ||
                  "").trim()}
                >
                  ${metric.label ?? metric.name ?? ""}
                </div>
                <x-metric .metric=${metric}></x-metric>
              </div>
            `,
          )}
        </div>
      `;
    };

    const renderResources = () => {
      if (pkg.stats.systemMetrics.length === 0) {
        return html`
          <div class="metrics-wrap">
            <p class="no-metrics">No resource metrics available</p>
          </div>
        `;
      }

      return html`
        <div class="metrics-wrap">
          ${pkg.stats.systemMetrics.map(
            (metric) => html`
              <div class="metric-container">
                <div
                  class="metric-label"
                  title=${(metric.description ||
                  metric.label ||
                  metric.name ||
                  "").trim?.() || ""}
                >
                  ${metric.label ?? metric.name ?? ""}
                </div>
                <x-metric .metric=${metric}></x-metric>
              </div>
            `,
          )}
        </div>
      `;
    };

    const renderMenu = () => html`
      <action-row
        prefix="power"
        name="state"
        label="Enabled"
        ?disabled=${disableActions}
      >
        Enable or disable this Pup
        <sl-switch
          slot="suffix"
          ?checked=${!disableActions && pkg.state.enabled}
          @sl-input=${this.handleStartStop}
          ?disabled=${this.inflight_startstop ||
          labels.installationId !== "ready"}
        ></sl-switch>
      </action-row>

      <action-row prefix="gear" name="configure" label="Configure" .trigger=${this.handleMenuClick} ?disabled=${disableActions}>
        Customise ${pkg.state.manifest.meta.name}
      </action-row>

      <action-row
        prefix="display"
        name="logs"
        label="Logs"
        href="${window.location.pathname}/logs"
        ?disabled=${disableActions}
      >
        Unfiltered logs
      </action-row>
    `;

    const renderMore = () => html`
      ${nothing ||
      html`
        <action-row
          prefix="list-ul"
          name="readme"
          label="Read me"
          .trigger=${this.handleMenuClick}
        >
          Many info
        </action-row>
      `}

      <action-row
        prefix="boxes"
        name="deps"
        label="Dependencies"
        .trigger=${this.handleMenuClick}
      >
        Functionality this pup depends on from other pups.
      </action-row>

      <action-row
        prefix="box-arrow-up"
        name="ints"
        label="Interfaces"
        .trigger=${this.handleMenuClick}
      >
        Functionality this pup provides for other pups.
      </action-row>
    `;

    const renderCareful = () => html`
      <action-row
        prefix="trash3-fill"
        name="uninstall"
        label="Uninstall"
        .trigger=${this.handleMenuClick}
        ?disabled=${disableActions}
      >
        Remove this pup from your system
      </action-row>
    `;

    const sectionTitleClasses = classMap({
      "section-title": true,
      disabled: disableActions,
    });

    const hasLogs = this.activityLogs.length;

    return html`
      <div id="PageWrapper" class="wrapper">
        <section>
          <div
            style="display:flex; flex-direction: row; gap: 1em; margin-bottom: 6px;"
          >
            ${logo
              ? html`
                  <img
                    style="width: 91px; height: 91px;"
                    src="${logo}"
                  />
                `
              : nothing}
            <div
              style="display: flex; flex-direction: column; width: 100%;"
            >
              <div class="section-title">
                <h3>Status</h3>
              </div>
              ${this.renderStatus(labels, pkg)}
              <sl-progress-bar
                value="0"
                ?indeterminate=${isLoadingStatus ||
                isInstallationLoadingStatus}
                class="loading-bar ${statusInstallationId}"
              ></sl-progress-bar>
            </div>
          </div>
          <x-activity-log
            .logs=${this.activityLogs}
            name="${pkg.state.manifest.meta.name}"
          ></x-activity-log>
          ${this.renderActions(labels, hasLogs)}
        </section>

        ${isRunning
          ? html`
              <section>
                <div class=${sectionTitleClasses}>
                  <h3>Stats</h3>
                </div>
                ${renderStats()}
              </section>
            `
          : nothing}

        <section>
          <div class=${sectionTitleClasses}>
            <h3>About</h3>
          </div>
          <reveal-row style="margin-top:-1em;">
            ${long
              ? html`<p>${long}</p>`
              : html`
                  <small
                    style="font-family: 'Comic Neue'; color: var(--sl-color-neutral-600);"
                    >Such empty, no description.</small
                  >
                `}
          </reveal-row>
        </section>

        <section>
          <div class=${sectionTitleClasses}>
            <h3>Menu</h3>
          </div>
          <div class="list-wrap">${renderMenu()}</div>
        </section>

        ${hasChecks
          ? html`
              <section>
                <div class=${sectionTitleClasses}>
                  <h3>Health checks</h3>
                </div>
                <div class="list-wrap">${renderHealthChecks()}</div>
              </section>
            `
          : nothing}

        <section>
          <div class="section-title">
            <h3>Such More</h3>
          </div>
          <div class="list-wrap">${renderMore()}</div>
        </section>

        ${isRunning
          ? html`
              <section>
                <div class=${sectionTitleClasses}>
                  <h3>Resources</h3>
                </div>
                ${renderResources()}
              </section>
            `
          : nothing}

        <section>
          <div class="section-title">
            <h3>Much Care</h3>
          </div>
          <div class="list-wrap">${renderCareful()}</div>
        </section>
      </div>

      <aside>
        <sl-dialog
          class="distinct-header"
          id="PupMgmtDialog"
          ?open=${this.open_dialog}
          label=${this.open_dialog_label}
        >
          ${this.renderDialog()}
        </sl-dialog>
      </aside>
    `;
  }

  static styles = css`
    :host {
      position: relative;
      display: block;
      --indi: #777;
    }

    .wrapper {
      display: block;
      padding: 2em;
      position: relative;
    }

    .wrapper[data-freeze] {
      overflow: hidden;
    }

    h1,
    h2,
    h3 {
      margin: 0;
      padding: 0;
    }

    section {
      margin-bottom: 2em;
    }

    section div {
      margin-bottom: 1em;
    }

    section .section-title {
      margin-bottom: 0em;
    }

    section .section-title.disabled {
      color: var(--sl-color-neutral-400);
    }

    section .section-title h3 {
      text-transform: uppercase;
      font-family: "Comic Neue";
    }

    section div.underscored {
      border-bottom: 1px solid #333;
    }

    aside.page-popver[data-open] {
      display: block;
    }

    sl-dialog.distinct-header::part(header) {
      z-index: 960;
      background: rgb(24, 24, 24);
    }

    .loading-bar {
      --height: 1px;
      --track-color: #444;
      --indicator-color: #999;
      &.starting {
        --indicator-color: var(--sl-color-primary-600);
      }
      &.stopping {
        --indicator-color: var(--sl-color-danger-600);
      }
      &.uninstalling {
        --indicator-color: var(--sl-color-danger-600);
      }
      &.purging {
        --indicator-color: var(--sl-color-danger-600);
      }
    }

    .metrics-wrap {
      margin-top: 0.5em;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 1.5em;
      width: 100%;
      align-items: stretch;
      grid-auto-rows: minmax(var(--sparkline-height, 160px), auto);
    }

    .metric-container {
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      border-radius: 8px;
      padding: 1em;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      overflow: hidden;
    }

    .metric-container > x-metric {
      display: block;
      height: 100%;
      width: 100%;
    }

    .metric-label {
      font-size: 0.9rem;
      font-weight: 600;
      color: #07ffae;
      margin: 0 0 0.35rem 0;
      user-select: text;
      pointer-events: auto;
    }
  `;
}

customElements.define("x-page-pup-library-listing", PupPage);
