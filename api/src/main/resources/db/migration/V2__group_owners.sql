ALTER TABLE conversations ADD COLUMN owner_id varchar(26);
ALTER TABLE conversations ADD CONSTRAINT conversations_owner_fk FOREIGN KEY (owner_id) REFERENCES users(id);
