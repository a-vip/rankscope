<?php
/**
 * RankScope data proxy (PHP implementation for Hostinger / any Apache+PHP host).
 *
 * Mirrors server/proxy.js exactly: same sources.json, parameters and JSON envelope.
 *   GET api/?s=<source>&q=...&hl=en&gl=us
 *   -> { ok, source, cached, fetchedAt, status, body }  |  { ok:false, error, status }
 *
 * API keys live in api/config.php (copy config.sample.php) or environment variables.
 * Requires PHP 7.4+ with the curl extension (standard on Hostinger).
 */

error_reporting(0);
ini_set('display_errors', '0');
@set_time_limit(45);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$CONFIG = [];
if (file_exists(__DIR__ . '/config.php')) {
    $loaded = include __DIR__ . '/config.php';
    if (is_array($loaded)) $CONFIG = $loaded;
}

function cfg($name) {
    global $CONFIG;
    if (!empty($CONFIG[$name])) return trim((string)$CONFIG[$name]);
    $v = getenv($name);
    return $v ? trim($v) : '';
}

$cors = cfg('CORS_ORIGIN');
header('Access-Control-Allow-Origin: ' . ($cors !== '' ? $cors : '*'));
header('Access-Control-Allow-Headers: X-Access-Token');

function out($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
if ($method === 'OPTIONS') out([], 204);
if ($method !== 'GET') out(['ok' => false, 'error' => 'Method not allowed'], 405);

$SOURCES = json_decode((string)file_get_contents(__DIR__ . '/sources.json'), true);
if (!is_array($SOURCES)) out(['ok' => false, 'error' => 'sources.json missing or invalid', 'status' => 500], 500);

const RS_UA = 'Mozilla/5.0 (compatible; RankScope/1.0; +https://github.com/a-vip/rankscope)';

$DFS_LOCATIONS = [
    'us' => 2840, 'gb' => 2826, 'ca' => 2124, 'au' => 2036, 'in' => 2356, 'de' => 2276, 'fr' => 2250,
    'es' => 2724, 'it' => 2380, 'br' => 2076, 'nl' => 2528, 'sg' => 2702, 'vn' => 2704, 'ph' => 2608,
    'nz' => 2554, 'za' => 2710, 'ie' => 2372, 'lk' => 2144, 'mx' => 2484, 'jp' => 2392, 'ae' => 2784,
    'my' => 2458, 'id' => 2360, 'th' => 2764, 'pk' => 2586, 'ng' => 2566, 'se' => 2752,
];

function valid_param($name, $v) {
    switch ($name) {
        case 'q': return is_string($v) && trim($v) !== '' && mb_strlen($v) <= 200;
        case 'hl':
        case 'gl': return (bool)preg_match('/^[a-z]{2}$/', $v);
        case 'article': return is_string($v) && $v !== '' && mb_strlen($v) <= 255 && !preg_match('/[\x00-\x1f]/', $v);
        case 'gran': return $v === 'daily' || $v === 'monthly';
        case 'start':
        case 'end': return (bool)preg_match('/^\d{8}(\d{2})?$/', $v);
        case 'y': return (bool)preg_match('/^\d{4}$/', $v);
        case 'm':
        case 'd': return (bool)preg_match('/^\d{2}$/', $v);
        case 'since': return (bool)preg_match('/^\d{1,11}$/', $v);
        case 'domains': return strlen($v) <= 4000 && (bool)preg_match('/^[a-z0-9.,-]+$/i', $v);
        case 'kw': return is_string($v) && $v !== '' && strlen($v) <= 12000;
    }
    return false;
}

function keyed_available($src) {
    if ($src === 'serp') return cfg('SERPER_API_KEY') !== '';
    if ($src === 'opr') return cfg('OPR_API_KEY') !== '';
    if ($src === 'dfsvol' || $src === 'dfskd') return cfg('DATAFORSEO_LOGIN') !== '' && cfg('DATAFORSEO_PASSWORD') !== '';
    return false;
}

function client_ip() {
    if (!empty($_SERVER['HTTP_CF_CONNECTING_IP'])) return $_SERVER['HTTP_CF_CONNECTING_IP'];
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) return trim(explode(',', $_SERVER['HTTP_X_FORWARDED_FOR'])[0]);
    return isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : 'unknown';
}

function cache_dir() {
    $d = __DIR__ . '/cache';
    if (!is_dir($d)) @mkdir($d, 0755, true);
    if (!file_exists($d . '/.htaccess')) @file_put_contents($d . '/.htaccess', "Require all denied\nDeny from all\n");
    return $d;
}

function rate_limited($ip, $keyed) {
    $limit = $keyed ? (int)(cfg('RATE_LIMIT_KEYED_PER_HOUR') ?: 120) : (int)(cfg('RATE_LIMIT_PER_MIN') ?: 300);
    $window = $keyed ? 3600 : 60;
    $file = cache_dir() . '/rl_' . ($keyed ? 'k_' : 'f_') . md5($ip) . '.json';
    $now = time();
    $state = ['start' => $now, 'n' => 0];
    $fh = @fopen($file, 'c+');
    if (!$fh) return false;
    flock($fh, LOCK_EX);
    $raw = stream_get_contents($fh);
    $prev = $raw ? json_decode($raw, true) : null;
    if (is_array($prev) && ($now - (int)$prev['start']) <= $window) $state = $prev;
    $state['n'] = (int)$state['n'] + 1;
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($state));
    flock($fh, LOCK_UN);
    fclose($fh);
    return $state['n'] > $limit;
}

function cache_get($key) {
    $file = cache_dir() . '/c_' . sha1($key) . '.json';
    if (!file_exists($file)) return null;
    $data = json_decode((string)@file_get_contents($file), true);
    if (!is_array($data) || time() > (int)$data['exp']) { @unlink($file); return null; }
    return $data;
}

function cache_set($key, $value, $ttl) {
    $value['exp'] = time() + (int)$ttl;
    @file_put_contents(cache_dir() . '/c_' . sha1($key) . '.json', json_encode($value, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), LOCK_EX);
    // Opportunistic cleanup (1% of requests)
    if (mt_rand(1, 100) === 1) {
        foreach ((array)glob(cache_dir() . '/c_*.json') as $f) {
            if (filemtime($f) < time() - 2592000) @unlink($f);
        }
    }
}

function fill_template($tpl, $p) {
    return preg_replace_callback('/\{(\w+)\}/', function ($m) use ($p) {
        $name = $m[1];
        if ($name === 'GL') return rawurlencode(strtoupper(isset($p['gl']) ? $p['gl'] : 'us'));
        if ($name === 'article') return rawurlencode(str_replace(' ', '_', $p['article']));
        return rawurlencode(isset($p[$name]) ? (string)$p[$name] : '');
    }, $tpl);
}

function http_call($url, $headers = [], $postBody = null, $timeout = 12) {
    $ch = curl_init($url);
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_CONNECTTIMEOUT => 6,
        CURLOPT_USERAGENT => RS_UA,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_ENCODING => '',
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
    ];
    if ($postBody !== null) {
        $opts[CURLOPT_POST] = true;
        $opts[CURLOPT_POSTFIELDS] = $postBody;
    }
    curl_setopt_array($ch, $opts);
    $body = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $ctype = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    $err = curl_errno($ch);
    curl_close($ch);
    if ($body === false) return ['status' => 0, 'body' => '', 'timeout' => $err === CURLE_OPERATION_TIMEDOUT];
    if (preg_match('/iso-8859-1|latin1/i', $ctype) && function_exists('mb_convert_encoding')) {
        $body = mb_convert_encoding($body, 'UTF-8', 'ISO-8859-1');
    }
    return ['status' => $status, 'body' => substr($body, 0, 2000000)];
}

function parse_kw_list($kw) {
    $list = [];
    foreach (explode("\n", (string)$kw) as $k) {
        $k = mb_strtolower(trim($k));
        if ($k !== '' && mb_strlen($k) <= 80) $list[$k] = true;
    }
    return array_slice(array_keys($list), 0, 100);
}

function fetch_upstream($src, $def, $p) {
    global $DFS_LOCATIONS;
    if (empty($def['keyed'])) {
        $hl = isset($p['hl']) ? $p['hl'] : 'en';
        return http_call(fill_template($def['url'], $p), ['Accept: */*', 'Accept-Language: ' . $hl . ';q=0.9']);
    }
    if ($src === 'serp') {
        $body = json_encode(['q' => $p['q'], 'gl' => $p['gl'], 'hl' => $p['hl'], 'num' => 10]);
        return http_call('https://google.serper.dev/search', ['X-API-KEY: ' . cfg('SERPER_API_KEY'), 'Content-Type: application/json'], $body);
    }
    if ($src === 'opr') {
        $parts = [];
        foreach (array_slice(array_filter(array_map('trim', explode(',', strtolower($p['domains'])))), 0, 100) as $d) {
            $parts[] = 'domains%5B%5D=' . rawurlencode($d);
        }
        return http_call('https://openpagerank.com/api/v1.0/getPageRank?' . implode('&', $parts), ['API-OPR: ' . cfg('OPR_API_KEY')]);
    }
    if ($src === 'dfsvol' || $src === 'dfskd') {
        $task = [
            'keywords' => parse_kw_list($p['kw']),
            'language_code' => $p['hl'],
            'location_code' => isset($DFS_LOCATIONS[$p['gl']]) ? $DFS_LOCATIONS[$p['gl']] : 2840,
        ];
        $endpoint = $src === 'dfsvol'
            ? 'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live'
            : 'https://api.dataforseo.com/v3/dataforseo_labs/google/bulk_keyword_difficulty/live';
        $auth = base64_encode(cfg('DATAFORSEO_LOGIN') . ':' . cfg('DATAFORSEO_PASSWORD'));
        return http_call($endpoint, ['Authorization: Basic ' . $auth, 'Content-Type: application/json'], json_encode([$task]), 30);
    }
    return ['status' => 0, 'body' => ''];
}

/* ------------------------------------------------------------------ */

$src = isset($_GET['s']) ? (string)$_GET['s'] : '';

if ($src === 'config') {
    $keyed = [];
    $labels = [];
    foreach ($SOURCES as $k => $d) {
        if (strpos($k, '_') === 0) continue;
        $labels[$k] = $d['label'];
        if (!empty($d['keyed'])) $keyed[$k] = keyed_available($k);
    }
    out(['ok' => true, 'backend' => 'php', 'version' => '1.0.0', 'keyed' => $keyed, 'sources' => $labels, 'tokenRequired' => cfg('ACCESS_TOKEN') !== '']);
}

if ($src === '' || strpos($src, '_') === 0 || !isset($SOURCES[$src])) out(['ok' => false, 'error' => 'Unknown source', 'status' => 400], 400);
$def = $SOURCES[$src];

$p = [];
foreach ($def['params'] as $name) {
    $v = isset($_GET[$name]) ? $_GET[$name] : '';
    if (is_array($v)) $v = reset($v);
    $v = (string)$v;
    if ($v === '') {
        if ($name === 'hl') $v = 'en';
        elseif ($name === 'gl') $v = 'us';
        elseif ($name === 'gran') $v = 'daily';
        else out(['ok' => false, 'error' => 'Missing parameter: ' . $name, 'status' => 400], 400);
    }
    if ($name === 'hl' || $name === 'gl') $v = strtolower($v);
    if (!valid_param($name, $v)) out(['ok' => false, 'error' => 'Invalid parameter: ' . $name, 'status' => 400], 400);
    $p[$name] = $v;
}

$isKeyed = !empty($def['keyed']);
if ($isKeyed) {
    if (!keyed_available($src)) out(['ok' => false, 'error' => $def['label'] . ' is not configured on this server', 'status' => 501], 501);
    $token = cfg('ACCESS_TOKEN');
    $given = isset($_SERVER['HTTP_X_ACCESS_TOKEN']) ? (string)$_SERVER['HTTP_X_ACCESS_TOKEN'] : '';
    if ($token !== '' && !hash_equals($token, $given)) out(['ok' => false, 'error' => 'Access token required for paid data sources', 'status' => 401], 401);
}

if (rate_limited(client_ip(), $isKeyed)) out(['ok' => false, 'error' => 'Rate limit reached. Slow down a little.', 'status' => 429], 429);

$cacheKey = $src . '|' . json_encode($p);
$hit = cache_get($cacheKey);
if ($hit) out(['ok' => true, 'source' => $src, 'cached' => true, 'fetchedAt' => $hit['fetchedAt'], 'status' => $hit['status'], 'body' => $hit['body']]);

$r = fetch_upstream($src, $def, $p);
$fetchedAt = gmdate('Y-m-d\TH:i:s\Z');
if ($r['status'] >= 200 && $r['status'] < 300) {
    cache_set($cacheKey, ['status' => $r['status'], 'body' => $r['body'], 'fetchedAt' => $fetchedAt], isset($def['ttl']) ? $def['ttl'] : 3600);
    out(['ok' => true, 'source' => $src, 'cached' => false, 'fetchedAt' => $fetchedAt, 'status' => $r['status'], 'body' => $r['body']]);
}
$err = $r['status'] === 0 ? (!empty($r['timeout']) ? 'Upstream timeout' : 'Upstream unreachable') : 'Upstream responded ' . $r['status'];
out(['ok' => false, 'source' => $src, 'error' => $err, 'status' => $r['status']]);

