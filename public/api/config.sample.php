<?php
/**
 * RankScope server configuration.
 * Copy this file to config.php (same folder) and fill in what you have.
 * Every key is OPTIONAL - the tool works with free sources only, and each key unlocks more accuracy.
 * config.php is git-ignored and blocked from web access by .htaccess.
 */
return [
    // Google SERP top-10, People Also Ask, related searches -> measured Keyword Difficulty.
    // https://serper.dev  (2,500 free searches on sign-up)
    'SERPER_API_KEY' => '',

    // Domain authority for SERP competitors and for your own site -> measured KD + rankability.
    // https://www.domcop.com/openpagerank/  (free)
    'OPR_API_KEY' => '',

    // Real Google Ads monthly search volume, CPC, 12-month history and industry KD.
    // https://dataforseo.com  (pay-as-you-go, roughly $0.05-0.08 per 100 keywords)
    'DATAFORSEO_LOGIN' => '',
    'DATAFORSEO_PASSWORD' => '',

    // If set, paid sources (above) only answer requests that send this token (enter it in the app's Settings).
    // Strongly recommended when the tool is public, so strangers cannot spend your API credits.
    'ACCESS_TOKEN' => '',

    // Restrict which website may call this API from a browser, e.g. 'https://aviperera.com'. Empty = any.
    'CORS_ORIGIN' => '',

    // Per-IP limits.
    'RATE_LIMIT_PER_MIN' => 300,
    'RATE_LIMIT_KEYED_PER_HOUR' => 120,
];

