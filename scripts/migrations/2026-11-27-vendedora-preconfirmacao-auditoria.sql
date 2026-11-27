-- Vendedora: papel, pré-confirmação de pagamento e auditoria.
-- Aplicar DEPOIS da revisão, com backup, numa janela curta.
-- Não altera orders.status, não reinterpreta PIX já pago e não mexe em dados existentes.
-- Idempotente: só cria tabela que ainda não existe. Sem DROP, sem UPDATE em orders.

-- Como aplicar com segurança:
-- 1. Backup do banco (dump) antes de qualquer comando.
-- 2. Conferir que este arquivo não contém UPDATE/DELETE em orders.
-- 3. Rodar este script no MySQL de produção, uma vez, com usuário que possa CREATE.
-- 4. Conferir: SHOW TABLES LIKE 'admin_user_roles'; SHOW TABLES LIKE 'order_payment_preconfirms'; SHOW TABLES LIKE 'admin_audit_log';
-- 5. Só então publicar o código que usa essas tabelas. Sem as tabelas, o login atual segue admin e a pré-confirmação responde que a migration falta.

CREATE TABLE IF NOT EXISTS admin_user_roles (
  user_id VARCHAR(255) NOT NULL,
  role VARCHAR(32) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS order_payment_preconfirms (
  id VARCHAR(64) NOT NULL,
  order_id VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL,
  confirmed_by VARCHAR(255) NOT NULL,
  confirmed_at TIMESTAMP NOT NULL,
  note TEXT NULL,
  proof_url MEDIUMTEXT NULL,
  reviewed_by VARCHAR(255) NULL,
  reviewed_at TIMESTAMP NULL,
  review_note TEXT NULL,
  pending_order_id VARCHAR(255)
    GENERATED ALWAYS AS (IF(status = 'pending_admin', order_id, NULL)) STORED,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_preconfirm_pending_order (pending_order_id),
  KEY idx_preconfirm_order (order_id),
  KEY idx_preconfirm_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_username VARCHAR(255) NOT NULL,
  actor_role VARCHAR(32) NOT NULL,
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(255) NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  ip VARCHAR(64) NULL,
  PRIMARY KEY (id),
  KEY idx_admin_audit_created (created_at),
  KEY idx_admin_audit_actor (actor_username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
