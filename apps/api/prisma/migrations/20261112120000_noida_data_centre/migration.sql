-- Our data centre is in Noida (it was set up as Gwalior). Only rows still holding the original
-- defaults are changed, so anything staff renamed themselves is left alone.
UPDATE "Location" SET "name" = 'Noida, India', "code" = 'NOI'
  WHERE "code" = 'GWL' AND "name" = 'Gwalior, India'
    AND NOT EXISTS (SELECT 1 FROM "Location" WHERE "code" = 'NOI');
UPDATE "ProductGroup" SET "headline" = 'Tier III data centre in Noida' WHERE "headline" = 'Tier III data centre in Gwalior';
UPDATE "Server" SET "name" = 'PVE Noida 1 (demo)' WHERE "name" = 'PVE Gwalior 1 (demo)';
UPDATE "Setting" SET "value" = jsonb_set("value"::jsonb, '{measuredFrom}', '"our Noida data centre"')
  WHERE "key" = 'brokerLatency' AND "value"::jsonb ->> 'measuredFrom' = 'our Gwalior data centre';
