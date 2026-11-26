import {
    html, render, Fragment,
    signal, effect,
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
    if (!json.ok) {
        if (json.code === 'auth_required') authenticated.value = false;
        throw new Error(json.error ?? 'Error desconocido');
    }
    return json.data;
}

function b64sql(sql) {
    return btoa(unescape(encodeURIComponent(sql)));
}

// ─── AUTH STATE ───────────────────────────────────────────────────────────────

const authenticated  = signal(null);   // null = comprobando sesión | true | false
const authConfigured = signal(true);   // se ajusta tras session_check

async function checkSession() {
    try {
        const d = await api('session_check');
        authConfigured.value = d.configured;
        authenticated.value  = d.authenticated;
    } catch {
        authenticated.value = false;
    }
}

async function doLogout() {
    try { await api('logout'); } catch {}
    authenticated.value = false;
}

// Descarga la ultima version de GitHub en el servidor y recarga la pagina
async function doUpdate() {
    if (!confirm('Actualizar MyDiff a la ultima version de GitHub?')) return;
    busy('update', true);
    try {
        const d = await api('update');
        alert(`MyDiff actualizado (${d.files} ficheros). Se recargara la pagina.`);
        location.reload();
    } catch (e) {
        alert('Error al actualizar: ' + e.message);
    } finally {
        busy('update', false);
    }
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
const connDlgOpen   = signal(false);
const connMgrOpen   = signal(false);
const editingConn   = signal(null);
const infoTableData   = signal(null);
const schemaMergeOpen = signal(false);
const defDiff         = signal(null);    // { kind:'TABLE'|'VIEW', srcName, trgName } - dialogo de estructura
const transferOpen    = signal(false);

// Routines
const routineCmp  = signal(null);   // { triggers:{src,trg,both,diff,...}, functions:{...}, procedures:{...} }
const routineDiff = signal(null);   // { type, name } — abre el diálogo de diff

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

// Iconos de accion (por codigo para mantener el fuente en ASCII)
const ICO_NEQ  = String.fromCharCode(0x2260);   // distinto
const ICO_SWAP = String.fromCharCode(0x21C4);   // flechas opuestas
const ICO_TRG  = String.fromCharCode(0x2192);   // flecha derecha
const ICO_SRC  = String.fromCharCode(0x2190);   // flecha izquierda
const ICO_RFSH = String.fromCharCode(0x21BB);   // flecha circular (refrescar)

// Identificador entre backticks
function bq(name) { return '`' + String(name).replace(/`/g, '``') + '`'; }

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

// Refresco manual de BBDD: mantiene la seleccion salvo que la BD ya no exista
async function refreshDBs() {
    if (!srcId.value || !trgId.value) return;
    busy('dbs', true);
    try {
        const cmp   = await api('compare_databases', { src: srcId.value, trg: trgId.value });
        dbCmp.value = cmp;
        addLog({ sql: 'SHOW DATABASES x 2 (refresco)', ok: true });
        const lostSrc = srcDb.value && !cmp.src.includes(srcDb.value);
        const lostTrg = trgDb.value && !cmp.trg.includes(trgDb.value);
        if (lostSrc) srcDb.value = null;
        if (lostTrg) trgDb.value = null;
        if (lostSrc || lostTrg) {
            srcTable.value   = null;
            trgTable.value   = null;
            tableCmp.value   = null;
            dataCmp.value    = null;
            routineCmp.value = null;
        }
    } catch (e) {
        addLog({ sql: 'SHOW DATABASES x 2 (refresco)', ok: false, err: e.message });
    } finally {
        busy('dbs', false);
    }
}

// Refresco manual de tablas, vistas y rutinas: mantiene la seleccion salvo lo que ya no exista
async function refreshTables() {
    const sDb = srcDb.value, tDb = trgDb.value;
    if (!sDb || !tDb) return;
    await Promise.all([compareTables(sDb, tDb, true), loadRoutines(sDb, tDb)]);
    const cmp = tableCmp.value;
    if (!cmp) return;
    const exists = (side, name) => ['tables', 'views'].some(key => (cmp[key]?.[side] ?? []).includes(name));
    if (srcTable.value && !exists('src', srcTable.value)) { srcTable.value = null; dataCmp.value = null; }
    if (trgTable.value && !exists('trg', trgTable.value)) { trgTable.value = null; dataCmp.value = null; }
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

// keepSel: refresca las listas sin perder la seleccion (p.ej. tras crear una tabla o vista)
async function compareTables(sDb, tDb, keepSel = false) {
    if (!srcId.value || !trgId.value || !sDb || !tDb) return;
    if (!keepSel) {
        srcTable.value   = null;
        trgTable.value   = null;
        dataCmp.value    = null;
        schemaDiff.value = { tables: [], views: [] };
    }
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
// Cambiar de conexion reinicia la comparacion; repetir la misma no hace nada
function selectSrcConn(id) {
    if (srcId.value === id) return;
    srcId.value = id;
    compareDBs();
}
function selectTrgConn(id) {
    if (trgId.value === id) return;
    trgId.value = id;
    compareDBs();
}

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
    const same    = !loading && norm(srcSql) === norm(trgSql);

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
                        ${srcSql && !same && html`
                            <button class="btn btn-sm btn-accent" disabled=${running}
                                onClick=${() => applyTo(tId, tDb, srcSql, 'trg')}>→ ${hasTrg ? 'aplicar' : 'crear'} en trg</button>
                        `}
                    </div>
                    <div class="rdiff-header-side">
                        ${trgSql && !same && html`
                            <button class="btn btn-sm btn-accent" disabled=${running}
                                onClick=${() => applyTo(sId, sDb, trgSql, 'src')}>← ${hasSrc ? 'aplicar' : 'crear'} en src</button>
                        `}
                        <span style="font-family:var(--code);font-size:11px;color:#888">trg: ${tDb}</span>
                    </div>
                </div>

                <${DiffView} left=${norm(srcSql)} right=${norm(trgSql)} />
            </${Fragment}>`}

            <div class="modal-actions">
                <button class="btn" onClick=${close}>Cerrar</button>
            </div>
        </div>
    </div>`;
}

// Diff lado a lado con numeros de linea (rutinas, vistas, tablas)
function DiffView({ left, right }) {
    let ln = 0, rn = 0;
    const rows = diffLines(left.split('\n'), right.split('\n')).map(row => ({
        ...row,
        lNum: row.t !== 'ad' ? ++ln : null,
        rNum: row.t !== 'rm' ? ++rn : null,
    }));

    return html`<div class="rdiff-wrap">
        <table class="rdiff-table">
            <tbody>
                ${rows.map((row, i) => html`<tr key=${i} class="rdiff-${row.t}">
                    <td class="rdiff-ln">${row.lNum ?? ''}</td>
                    <td class="rdiff-code">${row.l}</td>
                    <td class="rdiff-sep"></td>
                    <td class="rdiff-code">${row.r}</td>
                    <td class="rdiff-ln">${row.rNum ?? ''}</td>
                </tr>`)}
            </tbody>
        </table>
    </div>`;
}

// --- TABLE / VIEW DEFINITION DIALOG -------------------------------------------

// Separa la cabecera de SHOW CREATE VIEW (ALGORITHM, DEFINER, SQL SECURITY) del SELECT
function viewParts(sql) {
    const match = /\bVIEW\s+((?:`(?:[^`]|``)+`\.)?`(?:[^`]|``)+`)\s+AS\s+([\s\S]*)$/i.exec(sql ?? '');
    return match ? { name: match[1], body: match[2].trim() } : { name: '', body: (sql ?? '').trim() };
}

// MySQL devuelve el SELECT de una vista en una sola linea: lo partimos solo para mostrarlo
function fmtSelect(body) {
    return body
        .replace(/\s+(from|where|(?:(?:inner|left|right|cross)\s+)?join|group\s+by|order\s+by|having|union(?:\s+all)?|limit)\s+/gi, '\n$1 ')
        .replace(/(\sAS\s`(?:[^`]|``)+`),\s*/gi, '$1,\n    ');
}

function stripAutoInc(sql) {
    return (sql ?? '').replace(/\s+AUTO_INCREMENT=\d+/i, '');
}

function DefDiffDialog() {
    const { kind, srcName, trgName } = defDiff.value;
    const sId = srcId.value, tId = trgId.value;
    const sDb = srcDb.value, tDb = trgDb.value;
    const isView = kind === 'VIEW';

    const [srcSql,  setSrcSql]  = useState(null);
    const [trgSql,  setTrgSql]  = useState(null);
    const [running, setRunning] = useState(false);
    const [msgs,    setMsgs]    = useState([]);

    useEffect(() => {
        const get = (connId, db, name) => name
            ? api('get_routine', { connection_id: connId, db, type: kind, name }).then(d => d.sql)
            : Promise.resolve('');
        Promise.all([get(sId, sDb, srcName), get(tId, tDb, trgName)])
            .then(([s, t]) => { setSrcSql(s); setTrgSql(t); })
            .catch(e => { setMsgs([{ ok: false, text: e.message }]); setSrcSql(''); setTrgSql(''); });
    }, []);

    function close() { defDiff.value = null; }

    // Texto que se muestra en el diff
    function display(sql) {
        if (!sql) return '';
        if (!isView) return stripAutoInc(sql);
        const { name, body } = viewParts(sql);
        return `CREATE VIEW ${name} AS\n${fmtSelect(body)}`;
    }

    // Vista: CREATE OR REPLACE sin DEFINER. Tabla: CREATE TABLE (solo si no existe en destino)
    function buildSql(fromSql, name) {
        if (isView) return `CREATE OR REPLACE VIEW ${bq(name)} AS ${viewParts(fromSql).body}`;
        return stripAutoInc(fromSql).replace(/^CREATE\s+TABLE\s+(?:`(?:[^`]|``)+`\.)?`(?:[^`]|``)+`/i, `CREATE TABLE ${bq(name)}`);
    }

    async function applyTo(side) {
        const toTrg  = side === 'trg';
        const name   = toTrg ? (trgName ?? srcName) : (srcName ?? trgName);
        const connId = toTrg ? tId : sId;
        const db     = toTrg ? tDb : sDb;
        const sql    = buildSql(toTrg ? srcSql : trgSql, name);

        setRunning(true); setMsgs([]);
        try {
            await api('query', { connection_id: connId, sql: b64sql(sql), db });
            addLog({ sql, ok: true });
            setMsgs([{ ok: true, text: `${kind} ${name} aplicado en ${side}` }]);
            const fresh = await api('get_routine', { connection_id: connId, db, type: kind, name });
            if (toTrg) setTrgSql(fresh.sql); else setSrcSql(fresh.sql);
            compareTables(sDb, tDb, true);
        } catch(e) {
            setMsgs([{ ok: false, text: e.message }]);
            addLog({ sql, ok: false, err: e.message });
        } finally { setRunning(false); }
    }

    const loading = srcSql === null || trgSql === null;
    const same    = !loading && (isView
        ? viewParts(srcSql).body === viewParts(trgSql).body
        : stripAutoInc(srcSql) === stripAutoInc(trgSql));

    // Una tabla que ya existe en destino no se recrea (perderia los datos): para eso esta el schema merge
    const canToTrg = !loading && !!srcSql && !same && (isView || !trgSql);
    const canToSrc = !loading && !!trgSql && !same && (isView || !srcSql);
    const verbTrg  = trgSql ? 'reemplazar' : 'crear';
    const verbSrc  = srcSql ? 'reemplazar' : 'crear';
    const title    = srcName && trgName && srcName !== trgName ? `${srcName} / ${trgName}` : (srcName ?? trgName);

    return html`<div class="overlay" onClick=${e => e.target === e.currentTarget && close()}>
        <div class="modal routine-diff-modal">
            <div class="modal-title">${kind} -
                <span style="font-family:var(--code);font-size:12px;font-weight:400">${title}</span>
            </div>

            ${msgs.length > 0 && html`<div style="margin-bottom:10px">
                ${msgs.map((m, i) => html`<div key=${i} class="test-msg ${m.ok ? 'ok' : 'err'}">${m.ok ? 'OK ' : 'Error: '}${m.text}</div>`)}
            </div>`}

            ${loading && msgs.length === 0 && html`<div style="color:#666;padding:10px 0">Cargando...</div>`}

            ${!loading && html`<${Fragment}>
                <div class="rdiff-header">
                    <div class="rdiff-header-side">
                        <span style="font-family:var(--code);font-size:11px;color:#888">src: ${sDb}</span>
                        ${canToTrg && html`
                            <button class="btn btn-sm btn-accent" disabled=${running}
                                onClick=${() => applyTo('trg')}>${ICO_TRG} ${verbTrg} en trg</button>
                        `}
                    </div>
                    <div class="rdiff-header-side">
                        ${canToSrc && html`
                            <button class="btn btn-sm btn-accent" disabled=${running}
                                onClick=${() => applyTo('src')}>${ICO_SRC} ${verbSrc} en src</button>
                        `}
                        <span style="font-family:var(--code);font-size:11px;color:#888">trg: ${tDb}</span>
                    </div>
                </div>

                <${DiffView} left=${display(srcSql)} right=${display(trgSql)} />
            </${Fragment}>`}

            <div class="modal-actions">
                <button class="btn" onClick=${close}>Cerrar</button>
            </div>
        </div>
    </div>`;
}

// --- TRANSFER DATA DIALOG -----------------------------------------------------

const TRANSFER_MODES = [
    { key: 'truncate', label: 'TRUNCATE + INSERT ... SELECT',                where: false },
    { key: 'ignore',   label: 'INSERT IGNORE ... SELECT',                    where: true  },
    { key: 'upsert',   label: 'INSERT ... SELECT ON DUPLICATE KEY UPDATE',   where: true  },
];

function TransferDialog() {
    // Snapshot de la seleccion activa al abrir
    const sId  = srcId.value,    tId  = trgId.value;
    const sDb  = srcDb.value,    tDb  = trgDb.value;
    const sTbl = srcTable.value, tTbl = trgTable.value;

    const [dir,     setDir]     = useState('trg');      // lado destino
    const [mode,    setMode]    = useState('ignore');
    const [where,   setWhere]   = useState('');
    const [running, setRunning] = useState(false);
    const [msg,     setMsg]     = useState(null);

    const toTrg   = dir === 'trg';
    const from    = toTrg ? { id: sId, db: sDb, tbl: sTbl } : { id: tId, db: tDb, tbl: tTbl };
    const to      = toTrg ? { id: tId, db: tDb, tbl: tTbl } : { id: sId, db: sDb, tbl: sTbl };
    const modeDef = TRANSFER_MODES.find(m => m.key === mode);
    const native  = sId === tId;

    function close() { transferOpen.value = false; }

    async function run() {
        const label = `${from.db}.${from.tbl} ${ICO_TRG} ${to.db}.${to.tbl}`;
        setRunning(true); setMsg(null);
        try {
            const res = await api('transfer_data', {
                from: from.id, from_db: from.db, from_table: from.tbl,
                to:   to.id,   to_db:   to.db,   to_table:   to.tbl,
                mode,
                where: b64sql(modeDef.where ? where.trim() : ''),
            });
            let text = `${res.affected} filas afectadas`;
            if (res.read !== null)    text += ` (${res.read} leidas del origen)`;
            if (res.skipped.length)   text += ` - columnas omitidas: ${res.skipped.join(', ')}`;
            setMsg({ ok: true, text });
            addLog({ sql: res.sql, ok: true, rows: res.affected });
            loadData(0);
        } catch(e) {
            setMsg({ ok: false, text: e.message });
            addLog({ sql: `Transferir ${label}`, ok: false, err: e.message });
        } finally { setRunning(false); }
    }

    return html`<div class="overlay" onClick=${e => e.target === e.currentTarget && close()}>
        <div class="modal transfer-modal">
            <div class="modal-title">Transferir datos</div>

            <div class="field">
                <label>Sentido</label>
                <div class="transfer-dir">
                    <button class="btn btn-sm ${toTrg ? 'btn-accent' : ''}" onClick=${() => setDir('trg')}>src ${ICO_TRG} trg</button>
                    <button class="btn btn-sm ${toTrg ? '' : 'btn-accent'}" onClick=${() => setDir('src')}>src ${ICO_SRC} trg</button>
                </div>
                <div class="transfer-route">${from.db}.${from.tbl} ${ICO_TRG} ${to.db}.${to.tbl}</div>
            </div>

            <div class="field">
                <label>Modo</label>
                ${TRANSFER_MODES.map(m => html`
                    <label class="radio-row" key=${m.key}>
                        <input type="radio" name="transfer-mode" checked=${mode === m.key} onChange=${() => setMode(m.key)} />
                        <span>${m.label}</span>
                    </label>
                `)}
            </div>

            <div class="field">
                <label>WHERE sobre el origen (opcional)</label>
                <textarea class="schema-merge-textarea transfer-where"
                    value=${modeDef.where ? where : ''}
                    disabled=${!modeDef.where}
                    onInput=${e => setWhere(e.target.value)}
                    placeholder=${modeDef.where ? 'id > 1000 AND active = 1' : 'No se aplica con TRUNCATE'}
                    spellcheck="false"
                ></textarea>
            </div>

            <div class="transfer-note">
                ${native
                    ? 'Misma conexion: se ejecuta como SQL nativo.'
                    : 'Conexiones distintas: PHP lee el origen e inserta por lotes en el destino.'}
                ${' '}Solo se copian las columnas comunes a ambas tablas.
            </div>

            ${msg && html`<div class="test-msg ${msg.ok ? 'ok' : 'err'}">${msg.ok ? 'OK ' : 'Error: '}${msg.text}</div>`}

            <div class="modal-actions">
                <button class="btn" onClick=${close}>Cerrar</button>
                <button class="btn btn-accent" disabled=${running} onClick=${run}>
                    ${running ? '...' : `Ejecutar en ${dir}`}
                </button>
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
            <button class="btn btn-pill" title="Actualizar desde GitHub"
                disabled=${busyKeys.value.update} onClick=${doUpdate}>${busyKeys.value.update ? 'Updating...' : 'Update'}</button>
            <button class="btn btn-pill" title="Cerrar sesión" onClick=${doLogout}>Exit</button>
        </div>
    </header>`;
}

// ─── CONNECTIONS PANEL ────────────────────────────────────────────────────────

function ConnectionsPanel() {
    const open  = panelOpen.value.connections;
    const conns = connections.value;

    function toggle() { panelOpen.value = { ...panelOpen.value, connections: !open }; }

    // Misma lista en los dos lados: a la izquierda se elige src y a la derecha trg
    function connList(current, onPick) {
        return conns.map(conn => html`
            <div class="list-item ${current === conn.id ? 'selected' : ''}"
                title="${conn.user}@${conn.host}:${conn.port ?? 3306}"
                onClick=${() => onPick(conn.id)}>
                ${conn.name}
            </div>
        `);
    }

    return html`<div class="panel">
        <div class="panel-toolbar ${open ? '' : 'no-border'}">
            <span class="fold-btn" onClick=${toggle}>${open ? html`<${ChevronDown}/>` : html`<${ChevronRight}/>`}</span>
            <span class="panel-title">Connections</span>
            <div class="panel-tools">
                <button class="btn btn-pill" title="Gestionar conexiones"
                    onClick=${() => connMgrOpen.value = true}>⚙</button>
            </div>
        </div>
        ${open && (conns.length === 0
            ? html`<div class="conn-empty">Sin conexiones configuradas. Crea una desde el gestor de conexiones.</div>`
            : html`<div class="lists-row">
                <div class="list-col">${connList(srcId.value, selectSrcConn)}</div>
                <div class="list-col">${connList(trgId.value, selectTrgConn)}</div>
            </div>`)}
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
            <button class="refresh-btn" title="Refrescar bases de datos" disabled=${isLoading} onClick=${refreshDBs}>${ICO_RFSH}</button>
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

    // Pareja seleccionada (una en cada lado) dentro de la pestana actual: habilita los iconos de accion
    const kind    = tab === 'views' ? 'VIEW' : 'TABLE';
    const pairSel = !isRoutine && allSrc.has(srcTable.value) && allTrg.has(trgTable.value);

    function cmpData(e) {
        e.stopPropagation();
        panelOpen.value = { ...panelOpen.value, data: true };
        loadData(0);
    }
    function cmpStruct(e) {
        e.stopPropagation();
        if (kind === 'VIEW') defDiff.value = { kind, srcName: srcTable.value, trgName: trgTable.value };
        else schemaMergeOpen.value = true;
    }
    // Elemento que solo existe en un lado: abre su CREATE con el boton para crearlo en el otro
    function sendTo(e, name, side) {
        e.stopPropagation();
        defDiff.value = side === 'trg'
            ? { kind, srcName: name, trgName: null }
            : { kind, srcName: null, trgName: name };
    }

    function actIcons(name, side, selected, missingOther) {
        if (isRoutine) return null;
        return html`<span class="list-icons">
            ${selected && pairSel && html`
                <span class="info-icon act-icon" title="Comparar datos" onClick=${cmpData}>${ICO_NEQ}</span>
                <span class="info-icon act-icon" title="Comparar / clonar estructura" onClick=${cmpStruct}>${ICO_SWAP}</span>
            `}
            ${missingOther && html`
                <span class="info-icon act-icon" title="Crear en ${side === 'src' ? 'trg' : 'src'}"
                    onClick=${e => sendTo(e, name, side === 'src' ? 'trg' : 'src')}>${side === 'src' ? ICO_TRG : ICO_SRC}</span>
            `}
            <span class="info-icon" onClick=${e => showInfo(e, name, side)}>ℹ</span>
        </span>`;
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
            <button class="refresh-btn" title="Refrescar tablas, vistas y rutinas"
                disabled=${busyKeys.value.tables || busyKeys.value.routines} onClick=${refreshTables}>${ICO_RFSH}</button>
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
                        ${actIcons(name, 'src', srcTable.value === name, !allTrg.has(name))}
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
                        ${actIcons(name, 'trg', trgTable.value === name, !allSrc.has(name))}
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
                    <button class="btn btn-sm" title="Transferir datos entre src y trg" onClick=${() => transferOpen.value = true}>transferir</button>
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

// ─── LOGIN ────────────────────────────────────────────────────────────────────

function LoginScreen() {
    const configuring = !authConfigured.value;
    const [password, setPassword] = useState('');
    const [confirm, setConfirm]   = useState('');
    const [msg, setMsg]           = useState(null);
    const [busy, setBusy]         = useState(false);

    async function submit(e) {
        e.preventDefault();
        if (configuring && password !== confirm) { setMsg('Las contraseñas no coinciden'); return; }
        setBusy(true); setMsg(null);
        try {
            await api('login', { password });
            authConfigured.value = true;
            authenticated.value  = true;
        } catch (err) {
            setMsg(err.message);
        } finally {
            setBusy(false);
        }
    }

    return html`<div class="login-page">
        <form class="modal" onSubmit=${submit}>
            <div class="modal-title">${configuring ? 'Establece la contraseña de acceso' : 'MyDiff'}</div>
            <div class="field">
                <label>Contraseña</label>
                <input type="password" value=${password} autofocus
                    onInput=${e => setPassword(e.target.value)}
                    autocomplete=${configuring ? 'new-password' : 'current-password'} />
            </div>
            ${configuring && html`<div class="field">
                <label>Repite la contraseña</label>
                <input type="password" value=${confirm}
                    onInput=${e => setConfirm(e.target.value)} autocomplete="new-password" />
            </div>`}
            ${msg && html`<div class="test-msg err">✗ ${msg}</div>`}
            <div class="modal-actions">
                <button type="submit" class="btn btn-accent" disabled=${busy || !password}>
                    ${busy ? '…' : (configuring ? 'Crear contraseña' : 'Entrar')}
                </button>
            </div>
        </form>
    </div>`;
}

// ─── APP ──────────────────────────────────────────────────────────────────────

function MainApp() {
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
        ${connDlgOpen.value    && html`<${ConnectionDialog} />`}
        ${infoTableData.value  && html`<${TableInfoDialog} />`}
        ${connMgrOpen.value    && html`<${ConnManagerDialog} />`}
        ${schemaMergeOpen.value && html`<${SchemaMergeDialog} />`}
        ${routineDiff.value    && html`<${RoutineDiffDialog} />`}
        ${defDiff.value        && html`<${DefDiffDialog} />`}
        ${transferOpen.value   && html`<${TransferDialog} />`}
    </${Fragment}>`;
}

function App() {
    useEffect(() => { checkSession(); }, []);

    if (authenticated.value === null) return html`<div class="login-page"></div>`;
    if (!authenticated.value)         return html`<${LoginScreen} />`;
    return html`<${MainApp} />`;
}

// ─── BOOTSTRAP ────────────────────────────────────────────────────────────────

render(html`<${App} />`, document.getElementById('app'));
