package com.andrewtinyakov.messenger.shared.web

import tools.jackson.core.JsonParser
import tools.jackson.core.JsonToken
import tools.jackson.databind.DeserializationContext
import tools.jackson.databind.ValueDeserializer

class StrictStringDeserializer : ValueDeserializer<String>() {
    override fun deserialize(parser: JsonParser, context: DeserializationContext): String {
        if (!parser.hasToken(JsonToken.VALUE_STRING)) {
            return context.reportInputMismatch(String::class.java, "Expected a JSON string")
        }
        return parser.string
    }

    override fun getNullValue(context: DeserializationContext): String =
        context.reportInputMismatch(String::class.java, "Expected a JSON string")
}
