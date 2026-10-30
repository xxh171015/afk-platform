ALTER TABLE "specs" ADD COLUMN "order_broken" jsonb DEFAULT '[]'::jsonb NOT NULL;
