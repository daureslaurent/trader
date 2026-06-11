CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('cache_ttl_hours',        '13'),
  ('stop_loss_atr',          '2'),
  ('take_profit_atr',        '4'),
  ('max_risk_per_trade',     '0.02'),
  ('max_open_positions',     '5'),
  ('watchlist',              '[]'),
  ('pipeline_cron',          '0 * * * *'),
  ('min_confidence',         '0.3'),
  ('max_position_size_usd',  '100'),
  ('approval_required',      'false'),
  ('fee_rate',               '0.001'),
  ('discover_cron',          '0 6 * * *'),
  ('discover_min_score',     '0.65'),
  ('discover_top_n',         '30'),
  ('discover_auto_add',      'false'),
  ('discover_min_volume_usd','5000000'),
  ('monitor_auto_run',       'false'),
  ('monitor_cron',           '0 */4 * * *'),
  ('oco_sl_buffer_pct',      '0.5'),
  ('min_trade_usdc',         '12');
