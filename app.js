import {
    html, render, Fragment,
    signal, computed, effect,
    useState, useEffect,
} from './preact.js';

// ─── SESSION STORAGE ─────────────────────────────────────────────────────────

const SS = 'mydiff:';
function ssGet(key, fallback = null) {
    try {
        const v = sessionStorage.getItem(SS + key);
        return v !== null ? JSON.parse(v) : fallback;
    } catch { return fallback; }
}
function ssSet(key, value) {
    try { sessionStorage.setItem(SS + key, JSON.stringify(value)); } catch {}
}

// ─── API ──────────────────────────────────────────────────────────────────────

async function api(action, body = {}) {
    const res  = await fetch(`api.php?action=${action}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error ?? 'Error desconocido');
    return json.data;
}

function b64sql(sql) {
    return btoa(unescape(encodeURIComponent(sql)));
}

// ─── STATE ────────────────────────────────────────────────────────────────────

const connections  = signal([]);
const srcId        = signal(ssGet('srcId'));
const trgId        = signal(ssGet('trgId'));

// Selecciones independientes src / trg
const srcDb        = signal(ssGet('srcDb'));
const trgDb        = signal(ssGet('trgDb'));
const srcTable     = signal(ssGet('srcTable'));
const trgTable     = signal(ssGet('trgTable'));

const activeTab    = signal(ssGet('activeTab', 'tables'));
const tableSearch  = signal(ssGet('tableSearch', ''));

const dbCmp        = signal(null);
const tableCmp     = signal(null);
const dataCmp      = signal(null);   // { mode:'compare'|'single', columns, rows, ... }
const dataPage     = signal(0);
const schemaDiff   = signal({ tables: [], views: [] });

const queryLog     = signal([]);
const busyKeys     = signal({});

const PANEL_DEFAULTS = { connections: true, databases: true, tables: true, data: true, console: true };
const panelOpen    = signal({ ...PANEL_DEFAULTS, ...ssGet('panelOpen', {}) });

// Diálogos
const pickerFor    = signal(null);       // 'src' | 'trg' | null
const connDlgOpen   = signal(false);
const connMgrOpen   = signal(false);
const editingConn   = signal(null);
const infoTableData   = signal(null);
const schemaMergeOpen = signal(false);

// Routines
const routineCmp  = signal(null);   // { triggers:{src,trg,both,diff,...}, functions:{...}, procedures:{...} }
const routineDiff = signal(null);   // { type, name } — abre el diálogo de diff

// ─── COMPUTED ─────────────────────────────────────────────────────────────────

const srcConn = computed(() => connections.value.find(c => c.id === srcId.value) ?? null);
const trgConn = computed(() => connections.value.find(c => c.id === trgId.value) ?? null);

// ─── PERSISTENCIA ────────────────────────────────────────────────────────────

effect(() => ssSet('srcId',     srcId.value));
effect(() => ssSet('trgId',     trgId.value));
effect(() => ssSet('srcDb',     srcDb.value));
effect(() => ssSet('trgDb',     trgDb.value));
effect(() => ssSet('srcTable',  srcTable.value));
effect(() => ssSet('trgTable',  trgTable.value));
effect(() => ssSet('activeTab',   activeTab.value));
effect(() => ssSet('tableSearch', tableSearch.value));
effect(() => ssSet('panelOpen',   panelOpen.value));

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function busy(key, val) { busyKeys.value = { ...busyKeys.value, [key]: val }; }

// Trunca valores largos (text, json…) para mostrar en tabla
function trunc(val, max = 128) {
    if (val == null) return '';
    const s = String(val);
    return s.length > max ? s.slice(0, max) + '…' : s;
}

function addLog(entry) {
    queryLog.value = [{ id: Date.now(), ts: new Date().toLocaleTimeString(), ...entry }, ...queryLog.value].slice(0, 80);
}

// ─── ACCIONES ────────────────────────────────────────────────────────────────

async function loadConnections() {
    const data = await api('connections');
    connections.value = data.slice().sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

async function compareDBs() {
    if (!srcId.value || !trgId.value) return;
    busy('dbs', true);
    try {
        dbCmp.value      = await api('compare_databases', { src: srcId.value, trg: trgId.value });
        srcDb.value      = null;
        trgDb.value      = null;
        srcTable.value   = null;
        trgTable.value   = null;
        tableCmp.value   = null;
        dataCmp.value    = null;
        routineCmp.value = null;
        addLog({ sql: 'SHOW DATABASES × 2', ok: true });
    } catch (e) {
        addLog({ sql: 'SHOW DATABASES × 2', ok: false, err: e.message });
    } finally {
        busy('dbs', false);
    }
}

async function compareTables(sDb, tDb) {
    if (!srcId.value || !trgId.value || !sDb || !tDb) return;
    srcTable.value   = null;
    trgTable.value   = null;
    dataCmp.value    = null;
    schemaDiff.value = { tables: [], views: [] };
    busy('tables', true);
    try {
        tableCmp.value = await api('compare_tables', {
            src: srcId.value, trg: trgId.value,
            src_db: sDb, trg_db: tDb,
        });
        addLog({ sql: `SHOW FULL TABLES: \`${sDb}\` vs \`${tDb}\``, ok: true });
    } catch (e) {
        addLog({ sql: `SHOW FULL TABLES: \`${sDb}\` vs \`${tDb}\``, ok: false, err: e.message });
    } finally {
        busy('tables', false);
    }
}

async function loadData(page = 0) {
    const hasSrc = !!(srcTable.value && srcId.value && srcDb.value);
    const hasTrg = !!(trgTable.value && trgId.value && trgDb.value);
    if (!hasSrc && !hasTrg) return;

    dataPage.value = page;
    busy('data', true);

    try {
        if (hasSrc && hasTrg) {
            // Modo comparación: traemos hasta 5000 filas y paginamos en cliente
            const data = await api('compare_data', {
                src: srcId.value,    trg: trgId.value,
                src_db: srcDb.value, trg_db: trgDb.value,
                src_table: srcTable.value, trg_table: trgTable.value,
                limit: 5000,
            });
            dataCmp.value = { mode: 'compare', ...data };
            addLog({ sql: `\`${srcDb.value}\`.\`${srcTable.value}\` ↔ \`${trgDb.value}\`.\`${trgTable.value}\``, ok: true });
        } else {
            // Modo single: paginación en servidor
            const connId = hasSrc ? srcId.value  : trgId.value;
            const db     = hasSrc ? srcDb.value  : trgDb.value;
            const table  = hasSrc ? srcTable.value : trgTable.value;
            const side   = hasSrc ? 'src' : 'trg';
            const data   = await api('get_rows', { connection_id: connId, db, table, page, page_size: 100 });
            dataCmp.value = { mode: 'single', side, ...data };
            addLog({ sql: `SELECT * FROM \`${db}\`.\`${table}\` (p.${page + 1})`, ok: true });
        }
    } catch(e) {
        addLog({ sql: 'load data', ok: false, err: e.message });
    } finally {
        busy('data', false);
    }
}

async function loadRoutines(sDb, tDb) {
    if (!srcId.value || !trgId.value || !sDb || !tDb) return;
    busy('routines', true);
    try {
        routineCmp.value = await api('list_routines', {
            src: srcId.value, trg: trgId.value,
            src_db: sDb, trg_db: tDb,
        });
    } catch(e) {
        addLog({ sql: `routines \`${sDb}\` vs \`${tDb}\``, ok: false, err: e.message });
    } finally {
        busy('routines', false);
    }
}

// Selección independiente de BD
function selectSrcDb(db) {
    srcDb.value      = db;
    srcTable.value   = null;
    trgTable.value   = null;
    dataCmp.value    = null;
    dataPage.value   = 0;
    routineCmp.value = null;
    if (trgDb.value) { compareTables(db, trgDb.value); loadRoutines(db, trgDb.value); }
    else tableCmp.value = null;
}
function selectTrgDb(db) {
    trgDb.value      = db;
    srcTable.value   = null;
    trgTable.value   = null;
    dataCmp.value    = null;
    dataPage.value   = 0;
    routineCmp.value = null;
    if (srcDb.value) { compareTables(srcDb.value, db); loadRoutines(srcDb.value, db); }
    else tableCmp.value = null;
}

// Selección independiente de tabla — sin carga automática
function selectSrcTable(tbl) {
    srcTable.value = tbl;
    dataCmp.value  = null;
    dataPage.value = 0;
}
function selectTrgTable(tbl) {
    trgTable.value = tbl;
    dataCmp.value  = null;
    dataPage.value = 0;
}

async function runQuery(connId, sql, db) {
    const conn = connections.value.find(c => c.id === connId);
    busy('query', true);
    try {
        const data = await api('query', { connection_id: connId, sql: b64sql(sql), db: db || null });
        addLog({ connName: conn?.name, sql, ok: true, rows: data.rows?.length ?? 0 });
        // Refrescar comparación activa
        if (srcTable.value || trgTable.value)    loadData(dataPage.value);
        else if (srcDb.value && trgDb.value)     compareTables(srcDb.value, trgDb.value);
        else if (srcId.value && trgId.value)     compareDBs();
    } catch (e) {
        addLog({ connName: conn?.name, sql, ok: false, err: e.message });
    } finally {
        busy('query', false);
    }
}

async function compareSchema() {
    const tab  = activeTab.value;
    const both = tableCmp.value?.[tab]?.both ?? [];
    if (!srcId.value || !trgId.value || !srcDb.value || !trgDb.value || both.length === 0) return;

    busy('schema', true);
    try {
        const data = await api('compare_schema', {
            src: srcId.value, trg: trgId.value,
            src_db: srcDb.value, trg_db: trgDb.value,
            type: tab, names: both,
        });
        schemaDiff.value = { ...schemaDiff.value, [tab]: data.different };
        addLog({ sql: `Schema diff (${tab}): ${data.different.length} de ${both.length} distintas`, ok: true });
    } catch(e) {
        addLog({ sql: `compare_schema ${tab}`, ok: false, err: e.message });
    } finally {
        busy('schema', false);
    }
}

// Restaura comparaciones tras F5 sin tocar la selección guardada
async function restoreState() {
    const sId  = srcId.value;
    const tId  = trgId.value;
    const sDb  = srcDb.value;
    const tDb  = trgDb.value;
    const sTbl = srcTable.value;
    const tTbl = trgTable.value;

    if (!sId || !tId) return;

    busy('dbs', true);
    try {
        dbCmp.value = await api('compare_databases', { src: sId, trg: tId });
    } catch(e) {
        addLog({ sql: 'SHOW DATABASES × 2', ok: false, err: e.message });
        return;
    } finally { busy('dbs', false); }

    if (!sDb || !tDb) return;

    busy('tables', true);
    try {
        tableCmp.value = await api('compare_tables', {
            src: sId, trg: tId, src_db: sDb, trg_db: tDb,
        });
    } catch(e) {
        addLog({ sql: `SHOW TABLES: \`${sDb}\` vs \`${tDb}\``, ok: false, err: e.message });
        return;
    } finally { busy('tables', false); }

    loadRoutines(sDb, tDb);

    // Las señales srcTable/trgTable ya están restauradas desde sessionStorage;
    // el DataPanel aparece con el breadcrumb y el botón ≠ listo para pulsar.
}

// ─── LINE DIFF ────────────────────────────────────────────────────────────────

function diffLines(aLines, bLines) {
    const m = aLines.length, n = bLines.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = aLines[i-1] === bLines[j-1]
                ? dp[i-1][j-1] + 1
                : Math.max(dp[i-1][j], dp[i][j-1]);

    const edits = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && aLines[i-1] === bLines[j-1]) {
            edits.unshift({ t: 'eq', l: aLines[i-1], r: aLines[i-1] }); i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
            edits.unshift({ t: 'ad', l: '', r: bLines[j-1] }); j--;
        } else {
            edits.unshift({ t: 'rm', l: aLines[i-1], r: '' }); i--;
        }
    }

    // Empareja rm+ad consecutivos para vista side-by-side
    const rows = [];
    let k = 0;
    while (k < edits.length) {
        if (edits[k].t === 'eq') { rows.push(edits[k]); k++; }
        else {
            const rms = [], ads = [];
            while (k < edits.length && edits[k].t === 'rm') { rms.push(edits[k].l); k++; }
            while (k < edits.length && edits[k].t === 'ad') { ads.push(edits[k].r); k++; }
            const max = Math.max(rms.length, ads.length);
            for (let x = 0; x < max; x++) {
                const l = rms[x] ?? null, r = ads[x] ?? null;
                rows.push({ t: l !== null && r !== null ? 'ch' : l !== null ? 'rm' : 'ad', l: l ?? '', r: r ?? '' });
            }
        }
    }
    return rows;
}

// ─── ROUTINE DIFF DIALOG ──────────────────────────────────────────────────────

function RoutineDiffDialog() {
    const { type, name } = routineDiff.value;
    const sId = srcId.value, tId = trgId.value;
    const sDb = srcDb.value, tDb = trgDb.value;

    const [srcSql,  setSrcSql]  = useState(null);
    const [trgSql,  setTrgSql]  = useState(null);
    const [running, setRunning] = useState(false);
    const [msgs,    setMsgs]    = useState([]);

    const typeKey = type.toLowerCase() + 's';
    const listData = routineCmp.value?.[typeKey] ?? {};
    const hasSrc   = (listData.src ?? []).includes(name);
    const hasTrg   = (listData.trg ?? []).includes(name);

    useEffect(() => {
        const get = (connId, db, has) => has
            ? api('get_routine', { connection_id: connId, db, type, name }).then(d => d.sql).catch(() => '')
            : Promise.resolve('');
        Promise.all([get(sId, sDb, hasSrc), get(tId, tDb, hasTrg)])
            .then(([s, t]) => { setSrcSql(s); setTrgSql(t); })
            .catch(e => { setMsgs([{ ok: false, text: e.message }]); setSrcSql(''); setTrgSql(''); });
    }, []);

    function close() { routineDiff.value = null; }

    function norm(sql) {
        return (sql ?? '')
            .replace(/^(CREATE)\s+DEFINER\s*=\s*`[^`]*`\s*@\s*`[^`]*`\s+/i, '$1 ')
            .replace(/;+\s*$/, '').trim();
    }

    async function applyTo(connId, db, sql, label) {
        setRunning(true); setMsgs([]);
        try {
            await api('query', { connection_id: connId, sql: b64sql(`DROP ${type} IF EXISTS \`${name}\``), db });
            await api('query', { connection_id: connId, sql: b64sql(norm(sql)), db });
            addLog({ sql: `Apply ${type} \`${name}\` → ${label}`, ok: true });
            setMsgs([{ ok: true, text: `${type} \`${name}\` aplicado en ${label}` }]);
            const fresh = await api('get_routine', { connection_id: connId, db, type, name });
            if (label === 'trg') setTrgSql(fresh.sql); else setSrcSql(fresh.sql);
            loadRoutines(sDb, tDb);
        } catch(e) {
            setMsgs([{ ok: false, text: e.message }]);
            addLog({ sql: `Apply ${type} \`${name}\` → ${label}`, ok: false, err: e.message });
        } finally { setRunning(false); }
    }

    const loading = srcSql === null || trgSql === null;

    const diffRows = !loading ? (() => {
        let ln = 0, rn = 0;
        return diffLines(norm(srcSql).split('\n'), norm(trgSql).split('\n')).map(row => ({
            ...row,
            lNum: row.t !== 'ad' ? ++ln : null,
            rNum: row.t !== 'rm' ? ++rn : null,
        }));
    })() : [];

    return html`<div class="overlay" onClick=${e => e.target === e.currentTarget && close()}>
        <div class="modal routine-diff-modal">
            <div class="modal-title">${type} —
                <span style="font-family:var(--code);font-size:12px;font-weight:400">${name}</span>
            </div>

            ${msgs.length > 0 && html`<div style="margin-bottom:10px">
                ${msgs.map((m,i) => html`<div key=${i} class="test-msg ${m.ok?'ok':'err'}">${m.ok?'✓ ':'✗ '}${m.text}</div>`)}
            </div>`}

            ${loading && msgs.length === 0 && html`<div style="color:#666;padding:10px 0">Cargando…</div>`}

            ${!loading && html`<${Fragment}>
                <div class="rdiff-header">
                    <div class="rdiff-header-side">
                        <span style="font-family:var(--code);font-size:11px;color:#888">src: ${sDb}</span>
                        ${srcSql && hasTrg && html`
                            <button class="btn btn-sm btn-accent" disabled=${running}
                                onClick=${() => applyTo(tId, tDb, srcSql, 'trg')}>→ aplicar en trg</button>
                        `}
                    </div>
                    <div class="rdiff-header-side">
                        ${trgSql && hasSrc && html`
                            <button class="btn btn-sm btn-accent" disabled=${running}
                                onClick=${() => applyTo(sId, sDb, trgSql, 'src')}>← aplicar en src</button>
                        `}
                        <span style="font-family:var(--code);font-size:11px;color:#888">trg: ${tDb}</span>
                    </div>
                </div>

                <div class="rdiff-wrap">
                    <table class="rdiff-table">
                        <tbody>
                            ${diffRows.map((row, i) => html`<tr key=${i} class="rdiff-${row.t}">
                                <td class="rdiff-ln">${row.lNum ?? ''}</td>
                                <td class="rdiff-code">${row.l}</td>
                                <td class="rdiff-sep"></td>
                                <td class="rdiff-code">${row.r}</td>
                                <td class="rdiff-ln">${row.rNum ?? ''}</td>
                            </tr>`)}
                        </tbody>
                    </table>
                </div>
            </${Fragment}>`}

            <div class="modal-actions">
                <button class="btn" onClick=${close}>Cerrar</button>
            </div>
        </div>
    </div>`;
}

// ─── ICONS ────────────────────────────────────────────────────────────────────

function ChevronDown() {
    return html`<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M3 5 L7 9 L11 5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>
    </svg>`;
}
function ChevronRight() {
    return html`<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M5 3 L9 7 L5 11" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>
    </svg>`;
}

// ─── CONNECTION DIALOG ────────────────────────────────────────────────────────

function ConnectionDialog() {
    const base  = editingConn.value ?? {};
    const isNew = !base.id;
    const [form, setForm] = useState({
        name: base.name ?? '', host: base.host ?? 'localhost',
        port: base.port ?? 3306, user: base.user ?? '', pass: base.pass ?? '',
    });
    const [msg, setMsg]       = useState(null);
    const [testing, setTest]  = useState(false);

    function set(k) { return e => setForm(f => ({ ...f, [k]: e.target.value })); }

    async function doTest() {
        setTest(true); setMsg(null);
        try {
            const d = await api('test_connection', { host: form.host, port: form.port, user: form.user, pass: form.pass });
            setMsg({ ok: true, text: `MySQL ${d.version}` });
        } catch(e) { setMsg({ ok: false, text: e.message }); }
        finally     { setTest(false); }
    }

    async function doSave() {
        if (!form.name.trim() || !form.host.trim()) { setMsg({ ok: false, text: 'Nombre y host son obligatorios' }); return; }
        try {
            await api('save_connection', { id: base.id, ...form });
            await loadConnections();
            connDlgOpen.value = false; editingConn.value = null;
        } catch(e) { setMsg({ ok: false, text: e.message }); }
    }

    async function doDelete() {
        if (!confirm(`Eliminar "${base.name}"?`)) return;
        await api('delete_connection', { id: base.id });
        if (srcId.value === base.id) srcId.value = null;
        if (trgId.value === base.id) trgId.value = null;
        await loadConnections();
        connDlgOpen.value = false; editingConn.value = null;
    }

    function close() { connDlgOpen.value = false; editingConn.value = null; }

    return html`<div class="overlay" onClick=${e => e.target === e.currentTarget && close()}>
        <div class="modal">
            <div class="modal-title">${isNew ? 'Nueva conexión' : 'Editar conexión'}</div>
            <div class="field">
                <label>Nombre</label>
                <input type="text" value=${form.name} onInput=${set('name')} placeholder="Mi servidor" />
            </div>
            <div class="modal-row">
                <div class="field" style="flex:3">
                    <label>Host</label>
                    <input type="text" value=${form.host} onInput=${set('host')} placeholder="localhost" />
                </div>
                <div class="field" style="flex:1">
                    <label>Puerto</label>
                    <input type="number" value=${form.port} onInput=${set('port')} placeholder="3306" />
                </div>
            </div>
            <div class="modal-row">
                <div class="field">
                    <label>Usuario</label>
                    <input type="text" value=${form.user} onInput=${set('user')} autocomplete="off" />
                </div>
                <div class="field">
                    <label>Contraseña</label>
                    <input type="password" value=${form.pass} onInput=${set('pass')} autocomplete="new-password" />
                </div>
            </div>
            ${msg && html`<div class="test-msg ${msg.ok ? 'ok' : 'err'}">${msg.ok ? '✓ ' : '✗ '}${msg.text}</div>`}
            <div class="modal-actions">
                ${!isNew && html`<button class="btn btn-danger" onClick=${doDelete}>Eliminar</button>`}
                <button class="btn" onClick=${doTest} disabled=${testing}>${testing ? '…' : 'Test'}</button>
                <button class="btn" onClick=${close}>Cancelar</button>
                <button class="btn btn-accent" onClick=${doSave}>Guardar</button>
            </div>
        </div>
    </div>`;
}

// ─── CONNECTION PICKER ────────────────────────────────────────────────────────

function ConnectionPicker() {
    const side    = pickerFor.value;
    const conns   = connections.value;
    const current = side === 'src' ? srcId.value : trgId.value;

    function pick(id) {
        if (side === 'src') srcId.value = id;
        else                trgId.value = id;
        pickerFor.value = null;
        compareDBs();
    }
    function editConn(e, c) {
        e.stopPropagation();
        editingConn.value = c; connDlgOpen.value = true; pickerFor.value = null;
    }
    function newConn() {
        editingConn.value = null; connDlgOpen.value = true; pickerFor.value = null;
    }
    function close() { pickerFor.value = null; }

    return html`<div class="overlay" onClick=${e => e.target === e.currentTarget && close()}>
        <div class="modal">
            <div class="modal-title">Conexión ${side === 'src' ? 'origen (src)' : 'destino (trg)'}</div>
            ${conns.length === 0
                ? html`<div style="color:#666;font-size:12px;margin-bottom:12px">Sin conexiones configuradas</div>`
                : conns.map(c => html`
                    <div class="picker-item ${c.id === current ? 'selected' : ''}" onClick=${() => pick(c.id)}>
                        <div class="picker-name">${c.name}</div>
                        <div class="picker-host">${c.host}:${c.port ?? 3306}</div>
                        <button class="btn btn-sm" onClick=${e => editConn(e, c)}>✎</button>
                    </div>
                `)
            }
            <hr class="picker-sep" />
            <button class="btn" style="width:100%" onClick=${newConn}>+ Nueva conexión</button>
        </div>
    </div>`;
}

// ─── TABLE INFO DIALOG ────────────────────────────────────────────────────────

function TableInfoDialog() {
    const data = infoTableData.value;
    if (!data) return null;
    return html`<div class="overlay" onClick=${e => e.target === e.currentTarget && (infoTableData.value = null)}>
        <div class="modal" style="min-width:500px">
            <div class="modal-title">${data.name}</div>
            <table class="info-table">
                <thead><tr>
                    <th>Campo</th><th>Tipo</th><th>Null</th><th>Key</th><th>Default</th><th>Extra</th>
                </tr></thead>
                <tbody>
                    ${data.columns.map(r => html`<tr>
                        <td>${r.Field}</td><td>${r.Type}</td><td>${r.Null}</td>
                        <td>${r.Key}</td><td>${r.Default ?? ''}</td><td>${r.Extra}</td>
                    </tr>`)}
                </tbody>
            </table>
            <div class="modal-actions">
                <button class="btn" onClick=${() => infoTableData.value = null}>Cerrar</button>
            </div>
        </div>
    </div>`;
}

// ─── SCHEMA MERGE ─────────────────────────────────────────────────────────────

// Resumen legible de una columna para mostrar en la tabla
function colSummary(col) {
    if (!col) return '—';
    let s = col.Type;
    if (col.Null === 'NO') s += ' NOT NULL';
    if (col.Default != null) s += ' · ' + col.Default;
    if (col.Extra) s += ' · ' + col.Extra;
    if (col.Key === 'PRI') s += ' · PK';
    else if (col.Key === 'UNI') s += ' · UNI';
    return s;
}

// Definición SQL completa para ALTER TABLE
function colDefSql(col) {
    let s = `\`${col.Field}\` ${col.Type}`;
    s += col.Null === 'NO' ? ' NOT NULL' : ' NULL';
    if (col.Default != null) {
        const isFn = /^(CURRENT_TIMESTAMP(\(\))?|NOW\(\)|CURRENT_DATE(\(\))?|CURRENT_TIME(\(\))?|UUID\(\))$/i.test(String(col.Default));
        s += isFn ? ` DEFAULT ${col.Default}` : ` DEFAULT '${String(col.Default).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    }
    if (col.Extra) s += ` ${col.Extra}`;
    return s;
}

function afterClause(field, cols) {
    const idx = cols.findIndex(c => c.Field === field);
    return idx <= 0 ? 'FIRST' : `AFTER \`${cols[idx - 1].Field}\``;
}

function colsMatch(a, b) {
    if (!a || !b) return false;
    return ['Type', 'Null', 'Default', 'Extra'].every(k => (a[k] ?? null) === (b[k] ?? null));
}

function alignCols(srcCols, trgCols) {
    const srcSet = new Set(srcCols.map(c => c.Field));
    const trgMap = Object.fromEntries(trgCols.map(c => [c.Field, c]));
    const rows = srcCols.map(c => ({ field: c.Field, src: c, trg: trgMap[c.Field] ?? null }));
    for (const c of trgCols) {
        if (!srcSet.has(c.Field)) rows.push({ field: c.Field, src: null, trg: c });
    }
    return rows;
}

function SchemaMergeDialog() {
    // Snapshot de la selección activa al abrir
    const sId  = srcId.value;
    const tId  = trgId.value;
    const sDb  = srcDb.value;
    const tDb  = trgDb.value;
    const sTbl = srcTable.value;
    const tTbl = trgTable.value;

    const [cols,      setCols]      = useState(null);
    const [sqlToTrg,  setSqlToTrg]  = useState('');
    const [sqlToSrc,  setSqlToSrc]  = useState('');
    const [running,   setRunning]   = useState(false);
    const [msgs,      setMsgs]      = useState([]);
    const [onlyDiffs, setOnlyDiffs] = useState(true);

    useEffect(() => {
        api('get_columns', { src: sId, trg: tId, src_db: sDb, trg_db: tDb, src_table: sTbl, trg_table: tTbl })
            .then(setCols)
            .catch(e => setMsgs([{ ok: false, text: e.message }]));
    }, []);

    function close() { schemaMergeOpen.value = false; }

    function addToTrg(row) {
        if (!row.src) return;
        const sql = row.trg
            ? `ALTER TABLE \`${tDb}\`.\`${tTbl}\` MODIFY COLUMN ${colDefSql(row.src)};`
            : `ALTER TABLE \`${tDb}\`.\`${tTbl}\` ADD COLUMN ${colDefSql(row.src)} ${afterClause(row.field, cols.src)};`;
        setSqlToTrg(p => (p.trim() ? p.trimEnd() + '\n' : '') + sql);
    }

    function addToSrc(row) {
        if (!row.trg) return;
        const sql = row.src
            ? `ALTER TABLE \`${sDb}\`.\`${sTbl}\` MODIFY COLUMN ${colDefSql(row.trg)};`
            : `ALTER TABLE \`${sDb}\`.\`${sTbl}\` ADD COLUMN ${colDefSql(row.trg)} ${afterClause(row.field, cols.trg)};`;
        setSqlToSrc(p => (p.trim() ? p.trimEnd() + '\n' : '') + sql);
    }

    async function execSql(connId, db, sql) {
        if (!sql.trim()) return;
        setRunning(true);
        const results = [];
        for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
            try {
                await api('query', { connection_id: connId, sql: b64sql(stmt), db });
                results.push({ ok: true, text: stmt.slice(0, 100) + (stmt.length > 100 ? '…' : '') });
                addLog({ sql: stmt, ok: true });
            } catch(e) {
                results.push({ ok: false, text: e.message });
                addLog({ sql: stmt, ok: false, err: e.message });
            }
        }
        setMsgs(results);
        setRunning(false);
        // Recargar columnas para reflejar los cambios en la tabla
        api('get_columns', { src: sId, trg: tId, src_db: sDb, trg_db: tDb, src_table: sTbl, trg_table: tTbl })
            .then(d => { setCols(d); setMsgs([]); })
            .catch(() => {});
        compareSchema();
    }

    const aligned     = cols ? alignCols(cols.src, cols.trg) : [];
    const diffCount   = aligned.filter(r => !colsMatch(r.src, r.trg)).length;
    const displayRows = onlyDiffs ? aligned.filter(r => !colsMatch(r.src, r.trg)) : aligned;

    return html`<div class="overlay" onClick=${e => e.target === e.currentTarget && close()}>
        <div class="modal schema-merge-modal">
            <div class="modal-title">Schema merge —
                <span style="font-family:var(--code);font-size:12px;font-weight:400">${sDb}.${sTbl} ↔ ${tDb}.${tTbl}</span>
            </div>

            ${!cols && msgs.length === 0 && html`<div style="color:#666;padding:10px 0">Cargando columnas…</div>`}

            ${msgs.length > 0 && html`<div style="margin-bottom:10px">
                ${msgs.map((m, i) => html`<div key=${i} class="test-msg ${m.ok ? 'ok' : 'err'}">${m.ok ? '✓ ' : '✗ '}${m.text}</div>`)}
            </div>`}

            ${cols && html`<${Fragment}>
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                    <span style="font-size:11px;color:#666">${aligned.length} columnas · ${diffCount} diferencia${diffCount !== 1 ? 's' : ''}</span>
                    <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#888;cursor:pointer;margin-left:auto">
                        <input type="checkbox" checked=${onlyDiffs} onChange=${e => setOnlyDiffs(e.target.checked)} />
                        solo diferencias
                    </label>
                </div>

                <div class="schema-merge-table-wrap">
                    <table class="schema-merge-table">
                        <thead><tr>
                            <th>Campo</th>
                            <th>src — <em style="font-style:normal;color:#666">${sDb}.${sTbl}</em></th>
                            <th style="width:76px;text-align:center"></th>
                            <th>trg — <em style="font-style:normal;color:#666">${tDb}.${tTbl}</em></th>
                        </tr></thead>
                        <tbody>
                            ${displayRows.map(row => {
                                const same    = colsMatch(row.src, row.trg);
                                const srcOnly = !!row.src && !row.trg;
                                const trgOnly = !row.src && !!row.trg;
                                const cls     = same ? 'smerge-same' : srcOnly ? 'smerge-src-only' : trgOnly ? 'smerge-trg-only' : 'smerge-diff';
                                return html`<tr class=${cls}>
                                    <td class="smerge-field">${row.field}</td>
                                    <td class="smerge-def">${colSummary(row.src)}</td>
                                    <td class="smerge-arrows">
                                        ${!trgOnly && html`<button class="btn btn-sm" title="→ aplicar en trg" onClick=${() => addToTrg(row)}>→</button>`}
                                        ${!srcOnly && html`<button class="btn btn-sm" title="← aplicar en src" onClick=${() => addToSrc(row)}>←</button>`}
                                    </td>
                                    <td class="smerge-def">${colSummary(row.trg)}</td>
                                </tr>`;
                            })}
                            ${displayRows.length === 0 && html`
                                <tr><td colspan="4" style="padding:14px;color:#555;text-align:center">No hay diferencias</td></tr>
                            `}
                        </tbody>
                    </table>
                </div>

                <div class="schema-merge-sql-section">
                    <div class="schema-merge-sql-half">
                        <div class="schema-merge-sql-label">→ SQL para <strong>${tDb}.${tTbl}</strong></div>
                        <textarea class="schema-merge-textarea"
                            value=${sqlToTrg}
                            onInput=${e => setSqlToTrg(e.target.value)}
                            placeholder="Pulsa → en una fila para generar SQL…"
                            spellcheck="false"
                        ></textarea>
                        <div style="display:flex;gap:6px;margin-top:6px">
                            <button class="btn btn-sm" onClick=${() => setSqlToTrg('')}>Limpiar</button>
                            <button class="btn btn-accent btn-sm" style="margin-left:auto"
                                disabled=${running || !sqlToTrg.trim()}
                                onClick=${() => execSql(tId, tDb, sqlToTrg)}>
                                ${running ? '…' : 'Ejecutar en trg'}
                            </button>
                        </div>
                    </div>
                    <div class="schema-merge-sql-half">
                        <div class="schema-merge-sql-label">← SQL para <strong>${sDb}.${sTbl}</strong></div>
                        <textarea class="schema-merge-textarea"
                            value=${sqlToSrc}
                            onInput=${e => setSqlToSrc(e.target.value)}
                            placeholder="Pulsa ← en una fila para generar SQL…"
                            spellcheck="false"
                        ></textarea>
                        <div style="display:flex;gap:6px;margin-top:6px">
                            <button class="btn btn-sm" onClick=${() => setSqlToSrc('')}>Limpiar</button>
                            <button class="btn btn-accent btn-sm" style="margin-left:auto"
                                disabled=${running || !sqlToSrc.trim()}
                                onClick=${() => execSql(sId, sDb, sqlToSrc)}>
                                ${running ? '…' : 'Ejecutar en src'}
                            </button>
                        </div>
                    </div>
                </div>
            </${Fragment}>`}

            <div class="modal-actions">
                <button class="btn" onClick=${close}>Cerrar</button>
            </div>
        </div>
    </div>`;
}

// ─── CONNECTION MANAGER ───────────────────────────────────────────────────────

function ConnManagerDialog() {
    const conns = connections.value;

    async function doEdit(conn) {
        editingConn.value = conn;
        connDlgOpen.value = true;
        connMgrOpen.value = false;
    }

    async function doDuplicate(conn) {
        const { id, ...rest } = conn;
        await api('save_connection', { ...rest, name: conn.name + ' — copia' });
        await loadConnections();
    }

    async function doDelete(conn) {
        if (!confirm(`Eliminar "${conn.name}"?`)) return;
        await api('delete_connection', { id: conn.id });
        if (srcId.value === conn.id) srcId.value = null;
        if (trgId.value === conn.id) trgId.value = null;
        await loadConnections();
    }

    function newConn() {
        editingConn.value = null;
        connDlgOpen.value = true;
        connMgrOpen.value = false;
    }

    function close() { connMgrOpen.value = false; }

    return html`<div class="overlay" onClick=${e => e.target === e.currentTarget && close()}>
        <div class="modal" style="min-width:480px">
            <div class="modal-title">Gestionar conexiones</div>
            ${conns.length === 0
                ? html`<div style="color:#666;font-size:12px;margin-bottom:12px">Sin conexiones configuradas</div>`
                : conns.map(conn => html`
                    <div class="conn-mgr-item">
                        <div class="conn-mgr-info">
                            <div class="conn-mgr-name">${conn.name}</div>
                            <div class="conn-mgr-host">${conn.user}@${conn.host}:${conn.port ?? 3306}</div>
                        </div>
                        <div class="conn-mgr-actions">
                            <button class="btn btn-sm" title="Editar"     onClick=${() => doEdit(conn)}>✎</button>
                            <button class="btn btn-sm" title="Duplicar"   onClick=${() => doDuplicate(conn)}>⧉</button>
                            <button class="btn btn-sm btn-danger" title="Eliminar" onClick=${() => doDelete(conn)}>✕</button>
                        </div>
                    </div>
                `)
            }
            <hr class="picker-sep" />
            <div class="modal-actions" style="margin-top:0">
                <button class="btn" onClick=${newConn}>+ Nueva conexión</button>
                <button class="btn" onClick=${close}>Cerrar</button>
            </div>
        </div>
    </div>`;
}

// ─── HEADER ───────────────────────────────────────────────────────────────────

function Header() {
    return html`<header class="header">
        <div class="header-brand">MyDiff</div>
        <div class="header-warning">
            <strong>Undoing is for cowards.</strong>
            <em> All actions are executed inmediatly.</em>
        </div>
        <div class="header-end">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <circle cx="9" cy="9" r="8" stroke="#FF2777" stroke-width="1.5"/>
                <text x="9" y="13.5" text-anchor="middle" fill="#FF2777" font-family="Inter" font-size="11">!</text>
            </svg>
        </div>
    </header>`;
}

// ─── CONNECTIONS PANEL ────────────────────────────────────────────────────────

function ConnectionsPanel() {
    const open = panelOpen.value.connections;
    const src  = srcConn.value;
    const trg  = trgConn.value;

    function toggle() { panelOpen.value = { ...panelOpen.value, connections: !open }; }

    return html`<div class="panel">
        <div class="panel-toolbar ${open ? '' : 'no-border'}">
            <span class="fold-btn" onClick=${toggle}>${open ? html`<${ChevronDown}/>` : html`<${ChevronRight}/>`}</span>
            <span class="panel-title">Connections</span>
            <div class="panel-tools">
                <button class="btn btn-pill" onClick=${() => pickerFor.value = 'src'}>src</button>
                <button class="btn btn-pill" onClick=${() => pickerFor.value = 'trg'}>trg</button>
                <button class="btn btn-pill" title="Gestionar conexiones"
                    onClick=${() => connMgrOpen.value = true}>⚙</button>
            </div>
        </div>
        ${open && html`<div class="conn-body">
            <div class="conn-half">
                <span class="conn-label">src</span>
                <span class="conn-name ${src ? '' : 'conn-empty'}">${src ? src.name : '—'}</span>
            </div>
            <div class="conn-half">
                <span class="conn-label">trg</span>
                <span class="conn-name ${trg ? '' : 'conn-empty'}">${trg ? trg.name : '—'}</span>
            </div>
        </div>`}
    </div>`;
}

// ─── DATABASES PANEL ──────────────────────────────────────────────────────────

function DatabasesPanel() {
    const cmp       = dbCmp.value;
    const open      = panelOpen.value.databases;
    const isLoading = busyKeys.value.dbs;

    if (!srcId.value || !trgId.value) return null;

    function toggle() { panelOpen.value = { ...panelOpen.value, databases: !open }; }

    const srcList = cmp?.src ?? [];
    const trgList = cmp?.trg ?? [];

    // Una BD es "desparejada" si existe en un lado pero no en el otro
    const allSrc  = new Set(srcList);
    const allTrg  = new Set(trgList);

    return html`<div class="panel">
        <div class="panel-toolbar ${open ? '' : 'no-border'}">
            <span class="fold-btn" onClick=${toggle}>${open ? html`<${ChevronDown}/>` : html`<${ChevronRight}/>`}</span>
            <span class="panel-title">Databases</span>
            ${isLoading && html`<span class="loading-dot">…</span>`}
        </div>
        ${open && html`<div class="lists-row">
            <div class="list-col">
                ${srcList.map(name => html`
                    <div class="list-item
                        ${!allTrg.has(name)     ? 'mismatch' : ''}
                        ${srcDb.value === name   ? 'selected' : ''}"
                        onClick=${() => selectSrcDb(name)}>
                        ${name}
                    </div>
                `)}
            </div>
            <div class="list-col">
                ${trgList.map(name => html`
                    <div class="list-item
                        ${!allSrc.has(name)     ? 'mismatch' : ''}
                        ${trgDb.value === name   ? 'selected' : ''}"
                        onClick=${() => selectTrgDb(name)}>
                        ${name}
                    </div>
                `)}
            </div>
        </div>`}
    </div>`;
}

// ─── TABLES PANEL ─────────────────────────────────────────────────────────────

const ROUTINE_TABS = ['functions', 'procedures', 'triggers'];
const ROUTINE_TYPE = { functions: 'FUNCTION', procedures: 'PROCEDURE', triggers: 'TRIGGER' };

function TablesPanel() {
    const open        = panelOpen.value.tables;
    const tab         = activeTab.value;
    const search      = tableSearch.value;
    const isRoutine   = ROUTINE_TABS.includes(tab);
    const isLoading   = isRoutine ? busyKeys.value.routines : busyKeys.value.tables;
    const isSchemaRun = busyKeys.value.schema;

    if (!srcDb.value && !trgDb.value) return null;

    function toggle() { panelOpen.value = { ...panelOpen.value, tables: !open }; }

    const data      = isRoutine ? (routineCmp.value?.[tab] ?? {}) : (tableCmp.value?.[tab] ?? {});
    const diffNames = isRoutine ? new Set(data.diff ?? []) : new Set(schemaDiff.value[tab] ?? []);
    const q         = search.trim().toLowerCase();
    const srcList   = (data.src ?? []).filter(n => !q || n.toLowerCase().includes(q));
    const trgList   = (data.trg ?? []).filter(n => !q || n.toLowerCase().includes(q));
    const allSrc    = new Set(data.src ?? []);
    const allTrg    = new Set(data.trg ?? []);
    const hasBoth   = !isRoutine && (data.both ?? []).length > 0;

    async function showInfo(e, name, side) {
        e.stopPropagation();
        const connId = side === 'src' ? srcId.value : trgId.value;
        const db     = side === 'src' ? srcDb.value  : trgDb.value;
        try {
            const res = await api('query', { connection_id: connId, sql: b64sql(`DESCRIBE \`${db}\`.\`${name}\``), db });
            infoTableData.value = { name: `${db}.${name}`, columns: res.rows };
        } catch(err) {
            addLog({ sql: `DESCRIBE ${name}`, ok: false, err: err.message });
        }
    }

    function onSrcClick(name) {
        if (isRoutine) routineDiff.value = { type: ROUTINE_TYPE[tab], name };
        else selectSrcTable(name);
    }
    function onTrgClick(name) {
        if (isRoutine) routineDiff.value = { type: ROUTINE_TYPE[tab], name };
        else selectTrgTable(name);
    }

    return html`<div class="panel">
        <div class="panel-toolbar ${open ? '' : 'no-border'}">
            <span class="fold-btn" onClick=${toggle}>${open ? html`<${ChevronDown}/>` : html`<${ChevronRight}/>`}</span>
            <div class="tabs">
                <span class="tab ${tab==='tables'     ? 'active':''}" onClick=${() => activeTab.value='tables'}>Tables</span>
                <span class="tab ${tab==='views'      ? 'active':''}" onClick=${() => activeTab.value='views'}>Views</span>
                <span class="tab ${tab==='functions'  ? 'active':''}" onClick=${() => activeTab.value='functions'}>Functions</span>
                <span class="tab ${tab==='procedures' ? 'active':''}" onClick=${() => activeTab.value='procedures'}>Procedures</span>
                <span class="tab ${tab==='triggers'   ? 'active':''}" onClick=${() => activeTab.value='triggers'}>Triggers</span>
            </div>
            ${!isRoutine && html`<div class="panel-tools" style="margin-left:12px">
                <button class="btn btn-sm schema-btn"
                    title="Comparar esquemas de ${tab === 'tables' ? 'tablas' : 'vistas'} comunes"
                    disabled=${isSchemaRun || !hasBoth}
                    onClick=${compareSchema}>
                    ${isSchemaRun ? '…' : '≠'}
                </button>
            </div>`}
            <div class="table-search-wrap">
                <input class="table-search" type="text" placeholder="filtrar…"
                    value=${search} onInput=${e => tableSearch.value = e.target.value} />
                ${search && html`<button class="table-search-clear" onClick=${() => tableSearch.value = ''}>✕</button>`}
            </div>
            ${isLoading && html`<span class="loading-dot">…</span>`}
        </div>
        ${open && html`<div class="lists-row">
            <div class="list-col">
                <div style="color:#555;font-size:11px;margin-bottom:6px;font-family:var(--code)">${srcDb.value ?? '—'}</div>
                ${srcList.map(name => html`
                    <div class="list-item
                        ${!allTrg.has(name) ? 'mismatch' : ''}
                        ${allTrg.has(name) && diffNames.has(name) ? 'schema-diff' : ''}
                        ${!isRoutine && srcTable.value === name ? 'selected' : ''}"
                        onClick=${() => onSrcClick(name)}>
                        <span>${name}</span>
                        ${!isRoutine && html`<span class="info-icon" onClick=${e => showInfo(e, name, 'src')}>ℹ</span>`}
                    </div>
                `)}
            </div>
            <div class="list-col">
                <div style="color:#555;font-size:11px;margin-bottom:6px;font-family:var(--code)">${trgDb.value ?? '—'}</div>
                ${trgList.map(name => html`
                    <div class="list-item
                        ${!allSrc.has(name) ? 'mismatch' : ''}
                        ${allSrc.has(name) && diffNames.has(name) ? 'schema-diff' : ''}
                        ${!isRoutine && trgTable.value === name ? 'selected' : ''}"
                        onClick=${() => onTrgClick(name)}>
                        <span>${name}</span>
                        ${!isRoutine && html`<span class="info-icon" onClick=${e => showInfo(e, name, 'trg')}>ℹ</span>`}
                    </div>
                `)}
            </div>
        </div>`}
    </div>`;
}

// ─── DATA PANEL ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;

function DataPanel() {
    const cmp       = dataCmp.value;
    const open      = panelOpen.value.data;
    const page      = dataPage.value;
    const isLoading = busyKeys.value.data;
    const hasSrc    = !!srcTable.value;
    const hasTrg    = !!trgTable.value;

    if (!hasSrc && !hasTrg) return null;

    function toggle() { panelOpen.value = { ...panelOpen.value, data: !open }; }

    function clearData() {
        dataCmp.value  = null;
        dataPage.value = 0;
    }

    // ── Breadcrumb ──
    let breadcrumb;
    if (hasSrc && hasTrg)
        breadcrumb = `${srcDb.value ?? '?'}.${srcTable.value} ↔ ${trgDb.value ?? '?'}.${trgTable.value}`;
    else if (hasSrc)
        breadcrumb = `${srcDb.value ?? '?'}.${srcTable.value}`;
    else
        breadcrumb = `${trgDb.value ?? '?'}.${trgTable.value}`;

    // ── Datos paginados ──
    const columns = cmp?.columns ?? [];
    let displayRows = [], total = 0, totalPages = 0;

    if (cmp) {
        if (cmp.mode === 'compare') {
            const all  = cmp.rows ?? [];
            total      = all.length;
            totalPages = Math.ceil(total / PAGE_SIZE);
            displayRows = all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        } else {
            displayRows = cmp.rows ?? [];
            total       = cmp.total ?? 0;
            totalPages  = Math.ceil(total / PAGE_SIZE);
        }
    }

    function goPage(p) {
        if (cmp?.mode === 'single') loadData(p);
        else dataPage.value = p;
    }

    // ── Schema diff aviso ──
    const sd = cmp?.schemaDiff ?? { srcOnly: [], trgOnly: [] };
    const hasSchemaDiff = sd.srcOnly.length > 0 || sd.trgOnly.length > 0;

    // ── Filas de comparación ──
    function CompareRow({ row }) {
        if (row.status === 'ok') return html`
            <tr class="row-ok">
                <td class="status-cell">ok</td>
                ${columns.map(c => html`<td>${trunc(row.row[c])}</td>`)}
            </tr>`;
        if (row.status === 'diff') return html`<${Fragment}>
            <tr class="row-diff">
                <td class="status-cell">src</td>
                ${columns.map(c => html`<td class="${row.diffs.includes(c) ? 'diff-cell' : ''}">${trunc(row.src[c])}</td>`)}
            </tr>
            <tr class="row-diff">
                <td class="status-cell">trg</td>
                ${columns.map(c => html`<td class="${row.diffs.includes(c) ? 'diff-cell' : ''}">${trunc(row.trg[c])}</td>`)}
            </tr>
        </${Fragment}>`;
        const w = row.status === 'src_only' ? 'src' : 'trg';
        return html`<tr class="row-${w}">
            <td class="status-cell diff-cell">${w}</td>
            ${columns.map(c => html`<td class="diff-cell">${trunc(row.row[c])}</td>`)}
        </tr>`;
    }

    return html`<div class="panel">
        <div class="panel-toolbar ${open ? '' : 'no-border'}">
            <span class="fold-btn" onClick=${toggle}>${open ? html`<${ChevronDown}/>` : html`<${ChevronRight}/>`}</span>
            <span class="panel-title" style="font-family:var(--code);font-size:12px">${breadcrumb}</span>
            <div class="panel-tools" style="margin-left:12px">
                <button class="btn btn-sm schema-btn"
                    title="${hasSrc && hasTrg ? 'Comparar datos' : 'Ver datos'}"
                    disabled=${isLoading}
                    onClick=${() => loadData(0)}>
                    ${isLoading ? '…' : '≠'}
                </button>
                ${hasSrc && hasTrg && html`
                    <button class="btn btn-sm" title="Schema merge" onClick=${() => schemaMergeOpen.value = true}>⇄</button>
                `}
                <button class="btn btn-sm" title="Limpiar datos" onClick=${clearData}>✕</button>
            </div>
            ${cmp?.mode === 'compare' && !cmp.hasPk
                && html`<span class="loading-dot" style="color:#FF2777;margin-left:8px" title="Sin PK — comparando por fila completa">⚠ sin PK</span>`}
        </div>
        ${open && cmp && html`<div class="data-wrap">
            ${hasSchemaDiff && html`<div class="no-pk-warn">
                Diferencias de esquema —
                ${sd.srcOnly.length > 0 ? html`solo en src: <strong>${sd.srcOnly.join(', ')}</strong>` : null}
                ${sd.srcOnly.length > 0 && sd.trgOnly.length > 0 ? ' · ' : null}
                ${sd.trgOnly.length > 0 ? html`solo en trg: <strong>${sd.trgOnly.join(', ')}</strong>` : null}
            </div>`}
            <table class="diff-table">
                <thead><tr>
                    ${cmp.mode === 'compare' && html`<th></th>`}
                    ${columns.map(c => html`<th>${c}</th>`)}
                </tr></thead>
                <tbody>
                    ${cmp.mode === 'compare'
                        ? displayRows.map((row, i) => html`<${CompareRow} key=${i} row=${row} />`)
                        : displayRows.map((row, i) => html`<tr key=${i}>
                            ${columns.map(c => html`<td>${trunc(row[c])}</td>`)}
                          </tr>`)
                    }
                    ${displayRows.length === 0 && html`
                        <tr><td colspan=${columns.length + 1} style="color:#555;padding:10px">Sin datos</td></tr>
                    `}
                </tbody>
            </table>
            ${totalPages > 1 && html`<div class="paginator">
                <button class="btn btn-sm" disabled=${page === 0} onClick=${() => goPage(page - 1)}>←</button>
                <span class="paginator-info">${page + 1} / ${totalPages} &nbsp;(${total} filas)</span>
                <button class="btn btn-sm" disabled=${page >= totalPages - 1} onClick=${() => goPage(page + 1)}>→</button>
            </div>`}
        </div>`}
    </div>`;
}

// ─── CONSOLE PANEL ────────────────────────────────────────────────────────────

function ConsolePanel() {
    const [sql,  setSql]  = useState('');
    const [side, setSide] = useState('src');   // 'src' | 'trg'
    const log_      = queryLog.value;
    const open      = panelOpen.value.console;
    const isLoading = busyKeys.value.query;

    // Conexión y BD se derivan del lado seleccionado
    const connId = side === 'src' ? srcId.value  : trgId.value;
    const db     = side === 'src' ? srcDb.value  : trgDb.value;
    const conn   = connections.value.find(c => c.id === connId);

    function run() {
        const q = sql.trim();
        if (!q || !connId) return;
        runQuery(connId, q, db || null);
        setSql('');
    }

    function onKey(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
    }

    function toggleOpen() { panelOpen.value = { ...panelOpen.value, console: !open }; }
    function clearLog()   { queryLog.value = []; }

    return html`<div class="console">
        <div class="console-toolbar">
            <span class="fold-btn" onClick=${toggleOpen}>${open ? html`<${ChevronDown}/>` : html`<${ChevronRight}/>`}</span>
            <span style="color:#888;font-size:12px;margin-left:4px">Console</span>
            <div style="margin-left:auto;display:flex;gap:6px">
                ${log_.length > 0 && html`<button class="btn btn-sm" onClick=${clearLog} title="Limpiar">✕</button>`}
            </div>
        </div>
        ${open && html`<${Fragment}>
            <div class="console-log">
                ${log_.map(e => html`
                    <div class="console-log-item ${e.ok === false ? 'log-err' : ''}">
                        <span style="color:#444">${e.ts} </span>
                        ${e.connName ? html`<span style="color:#777">[${e.connName}] </span>` : null}
                        ${e.sql      ? html`<span>${e.sql}</span>` : null}
                        ${e.ok === true  ? html`<span style="color:#4a7a4a"> ✓${e.rows != null ? ` ${e.rows} filas` : ''}</span>` : null}
                        ${e.ok === false ? html`<span style="color:#FF2777"> ✗ ${e.err}</span>` : null}
                    </div>
                `)}
            </div>
            <div class="console-input-row">
                <div class="console-side-toggle">
                    <button class="btn btn-sm ${side==='src' ? 'btn-accent' : ''}" onClick=${() => setSide('src')}>src</button>
                    <button class="btn btn-sm ${side==='trg' ? 'btn-accent' : ''}" onClick=${() => setSide('trg')}>trg</button>
                </div>
                ${conn && html`<span class="console-conn-label">${conn.name}${db ? html` <em>${db}</em>` : ''}</span>`}
                ${!connId && html`<span class="console-conn-label" style="color:#555">sin conexión</span>`}
                <input
                    class="console-input"
                    type="text"
                    value=${sql}
                    placeholder="SQL… (Enter para ejecutar)"
                    onInput=${e => setSql(e.target.value)}
                    onKeyDown=${onKey}
                />
                <button class="btn" onClick=${run} disabled=${isLoading || !sql.trim() || !connId}>
                    ${isLoading ? '…' : '▶'}
                </button>
            </div>
        </${Fragment}>`}
    </div>`;
}

// ─── APP ──────────────────────────────────────────────────────────────────────

function App() {
    useEffect(() => {
        loadConnections().then(restoreState);

        const panels = ['connections', 'databases', 'tables', 'data'];
        function onKey(e) {
            if (!e.altKey) return;
            const idx = ['1','2','3','4'].indexOf(e.key);
            if (idx === -1) return;
            e.preventDefault();
            const key = panels[idx];
            panelOpen.value = { ...panelOpen.value, [key]: !panelOpen.value[key] };
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    return html`<${Fragment}>
        <${Header} />
        <main class="main">
            <${ConnectionsPanel} />
            <${DatabasesPanel} />
            <${TablesPanel} />
            <${DataPanel} />
        </main>
        <${ConsolePanel} />
        ${pickerFor.value      && html`<${ConnectionPicker} />`}
        ${connDlgOpen.value    && html`<${ConnectionDialog} />`}
        ${infoTableData.value  && html`<${TableInfoDialog} />`}
        ${connMgrOpen.value    && html`<${ConnManagerDialog} />`}
        ${schemaMergeOpen.value && html`<${SchemaMergeDialog} />`}
        ${routineDiff.value    && html`<${RoutineDiffDialog} />`}
    </${Fragment}>`;
}

// ─── BOOTSTRAP ────────────────────────────────────────────────────────────────

render(html`<${App} />`, document.getElementById('app'));
