-- The lifetime hour lock is retired: clear every stamp it left.
UPDATE "conversation" SET "is_over_cap" = false WHERE "is_over_cap" = true;
