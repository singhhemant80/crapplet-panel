-- Every VPS plan comes with 10 TB of bandwidth a month.
UPDATE "Product" SET "bandwidthGb" = 10000
 WHERE "type"::text LIKE 'VPS%' AND ("bandwidthGb" IS DISTINCT FROM 10000);

-- …and a plan's own feature lines say the same (order kept)
UPDATE "Product" p SET "features" = ARRAY(
    SELECT CASE WHEN f ~* '(bandwidth|traffic|transfer)' THEN '10 TB Bandwidth' ELSE f END
      FROM unnest(p."features") WITH ORDINALITY AS t(f, i) ORDER BY i)
 WHERE p."type"::text LIKE 'VPS%'
   AND EXISTS (SELECT 1 FROM unnest(p."features") f WHERE f ~* '(bandwidth|traffic|transfer)');
