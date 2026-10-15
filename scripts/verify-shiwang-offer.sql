-- READ ONLY. Run in the existing production database (DBeaver SQL editor or psql).
-- No ALTER/UPDATE/INSERT is required for this offer. Do not lower every variant
-- to 799.50: that would incorrectly discount single sets and would not expire.
-- Existing category ID observed on v1garments.com: 15. Match names, not a hardcoded ID.
WITH RECURSIVE eligible_categories AS (
  SELECT id FROM product_categories
  WHERE regexp_replace(lower(name),'[^a-z0-9]','','g') IN
    ('kurthipantset','kurtipantset','kurtapantset','kurthipantsets','kurtipantsets','kurtapantsets')
  UNION
  SELECT c.id FROM product_categories c JOIN eligible_categories a ON c.parent_id=a.id
)
SELECT p.id AS product_id,p.name,p.brand_name,p.gender,c.name AS category,
       v.id AS variant_id,v.size,v.colour,v.mrp,v.sale_price,v.b2c_discount_pct,
       GREATEST(0,COALESCE(s.on_hand,0)-COALESCE(s.reserved,0)) AS available_stock,
       p.is_active AND v.is_active AND COALESCE(s.is_active,false) AS active,
       990.00 AS campaign_single_price,1599.00 AS campaign_pair_price
FROM products p JOIN product_variants v ON v.product_id=p.id
JOIN product_categories c ON c.id=p.category_id
LEFT JOIN branch_variant_stock s ON s.variant_id=v.id AND s.branch_id=3
WHERE regexp_replace(lower(p.brand_name),'[^a-z0-9]','','g')='shiwang'
  AND regexp_replace(lower(p.gender),'[^a-z0-9]','','g') IN ('women','womens','woman','ladies','female')
  AND p.category_id IN (SELECT id FROM eligible_categories)
ORDER BY p.id,v.id;

-- Expected merchandise totals. Delivery/COD and reward redemption are separate.
SELECT quantity, (quantity/2)*1599+(quantity%2)*990 AS offer_total
FROM generate_series(1,10) AS quantity;

SELECT now() AT TIME ZONE 'Asia/Kolkata' AS india_time,
       now() >= TIMESTAMPTZ '2026-10-15 00:00:00+05:30'
       AND now() < TIMESTAMPTZ '2026-10-21 00:00:00+05:30' AS within_campaign_dates;
