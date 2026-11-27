package com.andrewtinyakov.messenger.infrastructure.database.generated;

import org.jooq.Field;
import org.jooq.impl.DSL;
import org.jooq.impl.SQLDataType;

public class GeneratedPackageProbe {
    public Field<Integer> plainField() {
        return DSL.field("1 + 1", SQLDataType.INTEGER);
    }
}

class HandwrittenSibling {
    Field<Integer> plainField() {
        return DSL.field("2 + 2", SQLDataType.INTEGER);
    }
}
