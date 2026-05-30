CREATE TABLE IF NOT EXISTS activation_codes (
  code TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unused', 'used', 'revoked')),
  created_at TEXT NOT NULL,
  used_at TEXT,
  license_id TEXT,
  device_id TEXT,
  order_id TEXT,
  note TEXT
);

CREATE TRIGGER IF NOT EXISTS normalize_activation_code_mode
AFTER INSERT ON activation_codes
FOR EACH ROW
WHEN NEW.mode = 'team'
BEGIN
  UPDATE activation_codes SET mode = 'enterprise' WHERE code = NEW.code;
END;

CREATE TABLE IF NOT EXISTS licenses (
  license_id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL,
  mode TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  FOREIGN KEY (code) REFERENCES activation_codes(code)
);

CREATE INDEX IF NOT EXISTS idx_activation_codes_status ON activation_codes(status);
CREATE INDEX IF NOT EXISTS idx_licenses_device_id ON licenses(device_id);
CREATE INDEX IF NOT EXISTS idx_licenses_expires_at ON licenses(expires_at);

CREATE TRIGGER IF NOT EXISTS normalize_license_mode
AFTER INSERT ON licenses
FOR EACH ROW
WHEN NEW.mode = 'team'
BEGIN
  UPDATE licenses SET mode = 'enterprise' WHERE license_id = NEW.license_id;
END;
