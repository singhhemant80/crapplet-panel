-- VPS logins follow the OS: Administrator on Windows, root on Linux (cPanel accounts and custom usernames untouched)
UPDATE "Service" s SET username = 'Administrator'
FROM "OsTemplate" o, "Product" p
WHERE s."osTemplateId" = o.id AND s."productId" = p.id
  AND p.provisioner IN ('VIRTUALIZOR', 'PROXMOX')
  AND (o.family = 'windows' OR o.name ILIKE '%windows%' OR o."remoteName" ~* '^win[0-9]')
  AND (s.username IS NULL OR s.username = 'root');
UPDATE "Service" s SET username = 'root'
FROM "OsTemplate" o, "Product" p
WHERE s."osTemplateId" = o.id AND s."productId" = p.id
  AND p.provisioner IN ('VIRTUALIZOR', 'PROXMOX')
  AND NOT (o.family = 'windows' OR o.name ILIKE '%windows%' OR o."remoteName" ~* '^win[0-9]')
  AND s.username = 'Administrator';
