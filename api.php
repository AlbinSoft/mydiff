<?php
header('Content-Type: application/json; charset=utf-8');

const CONN_FILE = __DIR__ . '/connections.json';

function readConns(): array {
    if (!file_exists(CONN_FILE)) return [];
    return json_decode(file_get_contents(CONN_FILE), true) ?? [];
}

function writeConns(array $c): void {
    file_put_contents(CONN_FILE, json_encode($c, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
}

function findConn(array $conns, string $id): ?array {
    foreach ($conns as $c) { if ($c['id'] === $id) return $c; }
    return null;
}

function pdo(array $conn, ?string $db = null): PDO {
    $host = $conn['host'];
    $port = $conn['port'] ?? 3306;
    $dsn  = "mysql:host=$host;port=$port;charset=utf8mb4" . ($db ? ";dbname=$db" : '');
    return new PDO($dsn, $conn['user'], $conn['pass'], [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_TIMEOUT            => 5,
    ]);
}

function ok(mixed $data): void {
    echo json_encode(['ok' => true, 'data' => $data]);
    exit;
}

function fail(string $msg): void {
    echo json_encode(['ok' => false, 'error' => $msg]);
    exit;
}

function bkt(string $name): string {
    return '`' . str_replace('`', '``', $name) . '`';
}

function columnsEqual(array $srcCols, array $trgCols): bool {
    if (count($srcCols) !== count($trgCols)) return false;
    foreach ($srcCols as $i => $col) {
        foreach (['Field', 'Type', 'Null', 'Default', 'Extra'] as $k) {
            if (($col[$k] ?? null) !== ($trgCols[$i][$k] ?? null)) return false;
        }
    }
    return true;
}

function viewBody(string $createSql): string {
    // Extrae desde la primera aparición de SELECT hasta el final
    $pos = stripos($createSql, 'SELECT');
    $body = $pos !== false ? substr($createSql, $pos) : $createSql;
    // Normaliza espacios para comparar
    return preg_replace('/\s+/', ' ', trim($body));
}

// ─── Acción ──────────────────────────────────────────────────────────────────

$action = $_GET['action'] ?? '';
$b      = json_decode(file_get_contents('php://input'), true) ?? [];

try {

    switch ($action) {

        // ── Conexiones guardadas ───────────────────────────────────────────

        case 'connections':
            ok(readConns());

        case 'save_connection': {
            $conns = readConns();
            $conn  = [
                'id'   => $b['id']   ?? uniqid('c', true),
                'name' => trim($b['name'] ?? ''),
                'host' => trim($b['host'] ?? ''),
                'port' => intval($b['port'] ?? 3306),
                'user' => trim($b['user'] ?? ''),
                'pass' => $b['pass'] ?? '',
            ];
            if (!$conn['name'] || !$conn['host']) fail('Nombre y host son obligatorios');
            $found = false;
            foreach ($conns as &$c) {
                if ($c['id'] === $conn['id']) { $c = $conn; $found = true; break; }
            }
            unset($c);
            if (!$found) $conns[] = $conn;
            writeConns($conns);
            ok($conn);
        }

        case 'delete_connection': {
            $id    = $b['id'] ?? '';
            $conns = array_values(array_filter(readConns(), fn($c) => $c['id'] !== $id));
            writeConns($conns);
            ok(true);
        }

        case 'test_connection': {
            $tmp = ['host' => $b['host'], 'port' => $b['port'] ?? 3306, 'user' => $b['user'], 'pass' => $b['pass']];
            $ver = pdo($tmp)->query('SELECT VERSION()')->fetchColumn();
            ok(['version' => $ver]);
        }

        // ── Comparaciones ─────────────────────────────────────────────────

        case 'compare_databases': {
            $conns = readConns();
            $src   = findConn($conns, $b['src'] ?? '') ?? fail('Conexión src no encontrada');
            $trg   = findConn($conns, $b['trg'] ?? '') ?? fail('Conexión trg no encontrada');

            $sys  = ['information_schema', 'mysql', 'performance_schema', 'sys'];
            $srcL = array_values(array_filter(
                pdo($src)->query('SHOW DATABASES')->fetchAll(PDO::FETCH_COLUMN),
                fn($d) => !in_array(strtolower($d), $sys)
            ));
            $trgL = array_values(array_filter(
                pdo($trg)->query('SHOW DATABASES')->fetchAll(PDO::FETCH_COLUMN),
                fn($d) => !in_array(strtolower($d), $sys)
            ));

            ok([
                'src'     => $srcL,
                'trg'     => $trgL,
                'srcOnly' => array_values(array_diff($srcL, $trgL)),
                'trgOnly' => array_values(array_diff($trgL, $srcL)),
                'both'    => array_values(array_intersect($srcL, $trgL)),
            ]);
        }

        case 'compare_tables': {
            $conns = readConns();
            $src   = findConn($conns, $b['src'] ?? '') ?? fail('Conexión src no encontrada');
            $trg   = findConn($conns, $b['trg'] ?? '') ?? fail('Conexión trg no encontrada');
            $srcDb = $b['src_db'] ?? $b['db'] ?? '';
            $trgDb = $b['trg_db'] ?? $b['db'] ?? '';

            $srcP  = pdo($src, $srcDb);
            $trgP  = pdo($trg, $trgDb);

            $tables = function(PDO $p, string $type): array {
                $t = $type === 'BASE TABLE' ? 'BASE TABLE' : 'VIEW';
                return $p->query("SHOW FULL TABLES WHERE Table_type = '$t'")->fetchAll(PDO::FETCH_COLUMN);
            };

            foreach (['tables' => 'BASE TABLE', 'views' => 'VIEW'] as $key => $type) {
                $s = $tables($srcP, $type);
                $t = $tables($trgP, $type);
                $result[$key] = [
                    'src'     => $s,
                    'trg'     => $t,
                    'srcOnly' => array_values(array_diff($s, $t)),
                    'trgOnly' => array_values(array_diff($t, $s)),
                    'both'    => array_values(array_intersect($s, $t)),
                ];
            }
            ok($result);
        }

        case 'compare_data': {
            $conns    = readConns();
            $src      = findConn($conns, $b['src'] ?? '') ?? fail('Conexión src no encontrada');
            $trg      = findConn($conns, $b['trg'] ?? '') ?? fail('Conexión trg no encontrada');
            $srcDb    = $b['src_db']    ?? $b['db']    ?? '';
            $trgDb    = $b['trg_db']    ?? $b['db']    ?? '';
            $srcTable = $b['src_table'] ?? $b['table'] ?? '';
            $trgTable = $b['trg_table'] ?? $b['table'] ?? '';
            $limit    = max(1, min(5000, intval($b['limit'] ?? 1000)));

            $srcP  = pdo($src, $srcDb);
            $trgP  = pdo($trg, $trgDb);
            $srcTB = bkt($srcTable);
            $trgTB = bkt($trgTable);

            // Columnas de cada tabla
            $srcCols    = $srcP->query("SHOW COLUMNS FROM $srcTB")->fetchAll(PDO::FETCH_COLUMN, 0);
            $trgCols    = $trgP->query("SHOW COLUMNS FROM $trgTB")->fetchAll(PDO::FETCH_COLUMN, 0);
            $commonCols = array_values(array_intersect($srcCols, $trgCols));

            // Primary key (src primero, si no trg)
            $pkCols = $srcP->query("SHOW KEYS FROM $srcTB WHERE Key_name = 'PRIMARY'")->fetchAll(PDO::FETCH_COLUMN, 4);
            if (!$pkCols) {
                $pkCols = $trgP->query("SHOW KEYS FROM $trgTB WHERE Key_name = 'PRIMARY'")->fetchAll(PDO::FETCH_COLUMN, 4);
            }

            // Fetch filas
            $srcRows = $srcP->query("SELECT * FROM $srcTB LIMIT $limit")->fetchAll();
            $trgRows = $trgP->query("SELECT * FROM $trgTB LIMIT $limit")->fetchAll();

            $makeKey = function(array $row) use ($pkCols, $commonCols): string {
                $keys = $pkCols ?: $commonCols;
                if (!$keys) return json_encode($row);
                return implode("\x00", array_map(fn($k) => (string)($row[$k] ?? ''), $keys));
            };

            $srcMap = [];
            foreach ($srcRows as $r) $srcMap[$makeKey($r)] = $r;
            $trgMap = [];
            foreach ($trgRows as $r) $trgMap[$makeKey($r)] = $r;

            $rows = [];
            foreach (array_unique(array_merge(array_keys($srcMap), array_keys($trgMap))) as $key) {
                $s = $srcMap[$key] ?? null;
                $t = $trgMap[$key] ?? null;

                if ($s && $t) {
                    $diffs = array_values(array_filter($commonCols, fn($c) => ($s[$c] ?? null) !== ($t[$c] ?? null)));
                    $rows[] = $diffs
                        ? ['status' => 'diff', 'src' => $s, 'trg' => $t, 'diffs' => $diffs]
                        : ['status' => 'ok', 'row' => $s, 'diffs' => []];
                } elseif ($s) {
                    $rows[] = ['status' => 'src_only', 'row' => $s, 'diffs' => []];
                } else {
                    $rows[] = ['status' => 'trg_only', 'row' => $t, 'diffs' => []];
                }
            }

            ok([
                'columns'    => $srcCols,
                'trgColumns' => $trgCols,
                'pkCols'     => $pkCols,
                'hasPk'      => !empty($pkCols),
                'schemaDiff' => [
                    'srcOnly' => array_values(array_diff($srcCols, $trgCols)),
                    'trgOnly' => array_values(array_diff($trgCols, $srcCols)),
                ],
                'rows'       => $rows,
            ]);
        }

        // ── Comparación de esquema (estructura de tablas / definición de vistas) ─

        case 'compare_schema': {
            $conns  = readConns();
            $src    = findConn($conns, $b['src'] ?? '') ?? fail('Conexión src no encontrada');
            $trg    = findConn($conns, $b['trg'] ?? '') ?? fail('Conexión trg no encontrada');
            $srcDb  = $b['src_db'] ?? '';
            $trgDb  = $b['trg_db'] ?? '';
            $type   = $b['type']  ?? 'tables';   // 'tables' | 'views'
            $names  = $b['names'] ?? [];

            $srcP   = pdo($src, $srcDb);
            $trgP   = pdo($trg, $trgDb);

            $different = [];

            if ($type === 'tables') {
                foreach ($names as $name) {
                    $tBkt    = bkt($name);
                    $srcCols = $srcP->query("SHOW COLUMNS FROM $tBkt")->fetchAll();
                    $trgCols = $trgP->query("SHOW COLUMNS FROM $tBkt")->fetchAll();
                    if (!columnsEqual($srcCols, $trgCols)) $different[] = $name;
                }
            } else {
                foreach ($names as $name) {
                    $vBkt   = bkt($name);
                    $srcRow = $srcP->query("SHOW CREATE VIEW $vBkt")->fetch();
                    $trgRow = $trgP->query("SHOW CREATE VIEW $vBkt")->fetch();
                    $srcDef = viewBody($srcRow['Create View'] ?? '');
                    $trgDef = viewBody($trgRow['Create View'] ?? '');
                    if ($srcDef !== $trgDef) $different[] = $name;
                }
            }

            ok(['different' => $different]);
        }

        // ── Columnas detalladas de un par de tablas (schema merge) ───────

        case 'get_columns': {
            $conns    = readConns();
            $src      = findConn($conns, $b['src'] ?? '') ?? fail('Conexión src no encontrada');
            $trg      = findConn($conns, $b['trg'] ?? '') ?? fail('Conexión trg no encontrada');
            $srcCols  = pdo($src, $b['src_db'] ?? '')->query("SHOW COLUMNS FROM " . bkt($b['src_table'] ?? ''))->fetchAll();
            $trgCols  = pdo($trg, $b['trg_db'] ?? '')->query("SHOW COLUMNS FROM " . bkt($b['trg_table'] ?? ''))->fetchAll();
            ok(['src' => $srcCols, 'trg' => $trgCols]);
        }

        // ── Routines: triggers, functions, procedures ─────────────────────

        case 'list_routines': {
            $conns = readConns();
            $src   = findConn($conns, $b['src'] ?? '') ?? fail('Conexión src no encontrada');
            $trg   = findConn($conns, $b['trg'] ?? '') ?? fail('Conexión trg no encontrada');
            $sDb   = $b['src_db'] ?? '';
            $tDb   = $b['trg_db'] ?? '';

            $srcP  = pdo($src, $sDb);
            $trgP  = pdo($trg, $tDb);
            $norm  = fn(string $s): string => preg_replace('/\s+/', ' ', trim($s));

            $getTriggers = function(PDO $p) use ($norm): array {
                $rows = $p->query("
                    SELECT TRIGGER_NAME as name,
                           CONCAT(ACTION_TIMING,' ',EVENT_MANIPULATION,' ON ',EVENT_OBJECT_TABLE,' ',ACTION_STATEMENT) as body
                    FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()
                    ORDER BY TRIGGER_NAME
                ")->fetchAll();
                return array_map(fn($r) => ['name' => $r['name'], 'body' => $norm($r['body'])], $rows);
            };

            $getRoutines = function(PDO $p, string $type) use ($norm): array {
                $q = $p->quote($type);
                $rows = $p->query("
                    SELECT ROUTINE_NAME as name, COALESCE(ROUTINE_DEFINITION,'') as body
                    FROM information_schema.ROUTINES
                    WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_TYPE = $q
                    ORDER BY ROUTINE_NAME
                ")->fetchAll();
                return array_map(fn($r) => ['name' => $r['name'], 'body' => $norm($r['body'])], $rows);
            };

            $cmp = function(array $si, array $ti): array {
                $sm = array_column($si, 'body', 'name');
                $tm = array_column($ti, 'body', 'name');
                $sn = array_keys($sm); $tn = array_keys($tm);
                $both = array_values(array_intersect($sn, $tn));
                return [
                    'src'     => $sn,
                    'trg'     => $tn,
                    'both'    => $both,
                    'srcOnly' => array_values(array_diff($sn, $tn)),
                    'trgOnly' => array_values(array_diff($tn, $sn)),
                    'diff'    => array_values(array_filter($both, fn($n) => $sm[$n] !== $tm[$n])),
                ];
            };

            ok([
                'triggers'   => $cmp($getTriggers($srcP),              $getTriggers($trgP)),
                'functions'  => $cmp($getRoutines($srcP, 'FUNCTION'),  $getRoutines($trgP, 'FUNCTION')),
                'procedures' => $cmp($getRoutines($srcP, 'PROCEDURE'), $getRoutines($trgP, 'PROCEDURE')),
            ]);
        }

        case 'get_routine': {
            $conns = readConns();
            $conn  = findConn($conns, $b['connection_id'] ?? '') ?? fail('Conexión no encontrada');
            $type  = strtoupper($b['type'] ?? '');
            $nBkt  = bkt($b['name'] ?? '');
            $p     = pdo($conn, $b['db'] ?? '');

            if ($type === 'TRIGGER') {
                $row = $p->query("SHOW CREATE TRIGGER $nBkt")->fetch();
                $sql = $row['SQL Original Statement'] ?? '';
            } elseif ($type === 'FUNCTION') {
                $row = $p->query("SHOW CREATE FUNCTION $nBkt")->fetch();
                $sql = $row['Create Function'] ?? '';
            } elseif ($type === 'PROCEDURE') {
                $row = $p->query("SHOW CREATE PROCEDURE $nBkt")->fetch();
                $sql = $row['Create Procedure'] ?? '';
            } else {
                fail("Tipo desconocido: $type");
            }
            ok(['sql' => $sql ?? '']);
        }

        // ── Filas de una tabla (modo single, paginación servidor) ─────────

        case 'get_rows': {
            $conns  = readConns();
            $conn   = findConn($conns, $b['connection_id'] ?? '') ?? fail('Conexión no encontrada');
            $db     = $b['db']    ?? '';
            $table  = $b['table'] ?? '';
            $page   = max(0, intval($b['page']      ?? 0));
            $size   = max(1, min(500, intval($b['page_size'] ?? 100)));
            $offset = $page * $size;

            $p    = pdo($conn, $db);
            $tBkt = bkt($table);

            $total = intval($p->query("SELECT COUNT(*) FROM $tBkt")->fetchColumn());
            $cols  = $p->query("SHOW COLUMNS FROM $tBkt")->fetchAll(PDO::FETCH_COLUMN, 0);
            $rows  = $p->query("SELECT * FROM $tBkt LIMIT $size OFFSET $offset")->fetchAll();

            ok(['columns' => $cols, 'rows' => $rows, 'total' => $total, 'page' => $page, 'pageSize' => $size]);
        }

        // ── Query libre ───────────────────────────────────────────────────

        case 'query': {
            $conns = readConns();
            $conn  = findConn($conns, $b['connection_id'] ?? '') ?? fail('Conexión no encontrada');
            $sql   = base64_decode($b['sql'] ?? '');
            $db    = $b['db'] ?? null;

            if (!$sql) fail('SQL vacío');

            $p    = pdo($conn, $db ?: null);
            $stmt = $p->query($sql);

            $columns = [];
            if ($stmt && $stmt->columnCount() > 0) {
                for ($i = 0; $i < $stmt->columnCount(); $i++) {
                    $meta      = $stmt->getColumnMeta($i);
                    $columns[] = $meta['name'];
                }
            }
            $rows = $stmt ? $stmt->fetchAll() : [];

            ok(['sql' => $sql, 'columns' => $columns, 'rows' => $rows, 'affected' => $stmt ? $stmt->rowCount() : 0]);
        }

        default:
            fail("Acción desconocida: $action");
    }

} catch (Throwable $e) {
    fail($e->getMessage());
}
