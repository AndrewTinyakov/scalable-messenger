package com.andrewtinyakov.messenger.infrastructure.config

import io.swagger.v3.oas.models.Components
import io.swagger.v3.oas.models.OpenAPI
import io.swagger.v3.oas.models.media.Content
import io.swagger.v3.oas.models.media.MediaType
import io.swagger.v3.oas.models.media.ObjectSchema
import io.swagger.v3.oas.models.media.StringSchema
import io.swagger.v3.oas.models.responses.ApiResponse
import io.swagger.v3.oas.models.security.SecurityRequirement
import io.swagger.v3.oas.models.security.SecurityScheme
import io.swagger.v3.oas.models.servers.Server
import org.springdoc.core.customizers.OpenApiCustomizer
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration
class OpenApiConfig {
    @Bean
    fun openApi(): OpenAPI =
        OpenAPI()
            .servers(listOf(Server().url("/api")))
            .components(
                Components()
                    .addSecuritySchemes(
                        "bearerAuth",
                        SecurityScheme().type(SecurityScheme.Type.HTTP).scheme("bearer").bearerFormat("opaque"),
                    ).addSchemas(
                        "ApiProblem",
                        ObjectSchema()
                            .addProperty("status", io.swagger.v3.oas.models.media.IntegerSchema())
                            .addProperty("detail", StringSchema())
                            .addProperty("code", StringSchema()),
                    ),
            ).addSecurityItem(SecurityRequirement().addList("bearerAuth"))

    @Bean
    fun problemResponses(): OpenApiCustomizer = OpenApiCustomizer { document ->
        document.components.addSchemas(
            "ApiProblem",
            ObjectSchema()
                .addProperty("status", io.swagger.v3.oas.models.media.IntegerSchema())
                .addProperty("detail", StringSchema())
                .addProperty("code", StringSchema()),
        )
        document.paths.forEach { (path, item) ->
            item.readOperations().forEach { operation ->
                operation.parameters?.removeIf { it.`in` == "header" && it.name.equals("Authorization", ignoreCase = true) }
                if (path == "/v1/auth/register" || path == "/v1/auth/login") {
                    operation.security = emptyList()
                } else {
                    operation.responses.addApiResponse("401", problem("Unauthorized"))
                    operation.responses.addApiResponse("403", problem("Forbidden"))
                }
                operation.responses.addApiResponse("400", problem("Invalid request"))
                operation.responses.addApiResponse("500", problem("Internal server error"))
            }
        }
    }

    private fun problem(description: String): ApiResponse =
        ApiResponse().description(description).content(
            Content().addMediaType(
                "application/problem+json",
                MediaType().schema(io.swagger.v3.oas.models.media.Schema<Any>().`$ref`("#/components/schemas/ApiProblem")),
            ),
        )
}
