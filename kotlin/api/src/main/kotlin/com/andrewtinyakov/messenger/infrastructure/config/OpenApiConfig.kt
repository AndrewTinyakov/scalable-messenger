package com.andrewtinyakov.messenger.infrastructure.config

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.web.SessionCookie
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import io.swagger.v3.oas.models.Components
import io.swagger.v3.oas.models.OpenAPI
import io.swagger.v3.oas.models.PathItem
import io.swagger.v3.oas.models.media.ArraySchema
import io.swagger.v3.oas.models.media.Content
import io.swagger.v3.oas.models.media.IntegerSchema
import io.swagger.v3.oas.models.media.MediaType
import io.swagger.v3.oas.models.media.ObjectSchema
import io.swagger.v3.oas.models.media.Schema
import io.swagger.v3.oas.models.media.StringSchema
import io.swagger.v3.oas.models.parameters.Parameter
import io.swagger.v3.oas.models.responses.ApiResponse
import io.swagger.v3.oas.models.security.SecurityRequirement
import io.swagger.v3.oas.models.security.SecurityScheme
import io.swagger.v3.oas.models.servers.Server
import org.springdoc.core.customizers.OpenApiCustomizer
import org.springdoc.core.utils.SpringDocUtils
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration
class OpenApiConfig {
    init {
        SpringDocUtils.getConfig().addRequestWrapperToIgnore(AuthenticatedSession::class.java)
    }

    @Bean
    fun openApi(): OpenAPI =
        OpenAPI()
            .servers(listOf(Server().url("/api")))
            .components(
                Components()
                    .addSecuritySchemes(
                        "sessionCookie",
                        SecurityScheme().type(SecurityScheme.Type.APIKEY).`in`(SecurityScheme.In.COOKIE).name(SessionCookie.SECURE_NAME),
                    ).addSchemas("ApiFieldError", fieldErrorSchema())
                    .addSchemas("ApiProblem", problemSchema()),
            ).addSecurityItem(SecurityRequirement().addList("sessionCookie"))

    @Bean
    fun problemResponses(): OpenApiCustomizer = OpenApiCustomizer { document ->
        document.components.addSchemas("ApiFieldError", fieldErrorSchema())
        document.components.addSchemas("ApiProblem", problemSchema())
        document.paths.forEach { (path, item) ->
            item.readOperationsMap().forEach { (method, operation) ->
                if (method !in setOf(PathItem.HttpMethod.GET, PathItem.HttpMethod.HEAD, PathItem.HttpMethod.OPTIONS)) {
                    operation.addParametersItem(
                        Parameter().`in`("header").name("X-Messenger-CSRF").required(true).schema(StringSchema()._enum(listOf("1"))),
                    )
                    operation.responses.addApiResponse("403", problem("Invalid browser request"))
                }
                operation.parameters?.removeIf { it.`in` == "header" && it.name.equals("Authorization", ignoreCase = true) }
                if (path == "/v1/auth/register" || path == "/v1/auth/login" || path == "/v1/auth/logout") {
                    operation.security = emptyList()
                } else {
                    operation.responses.addApiResponse("401", problem("Unauthorized"))
                    operation.responses.addApiResponse("403", problem("Forbidden"))
                }
                if (path != "/v1/auth/register" && path != "/v1/auth/login") {
                    listOf("X-Messenger-User", "X-Messenger-Device").forEach { name ->
                        operation.addParametersItem(Parameter().`in`("header").name(name).required(false).schema(StringSchema()))
                    }
                    operation.responses.addApiResponse("401", problem("Unauthorized"))
                }
                operation.responses.addApiResponse("400", problem("Invalid request"))
                operation.responses.addApiResponse("500", problem("Internal server error"))
            }
        }
    }

    private fun fieldErrorSchema(): ObjectSchema =
        ObjectSchema()
            .addProperty("field", StringSchema())
            .addProperty("message", StringSchema())
            .required(listOf("field", "message")) as ObjectSchema

    private fun problemSchema(): ObjectSchema =
        ObjectSchema()
            .addProperty("status", IntegerSchema())
            .addProperty("detail", StringSchema())
            .addProperty("code", StringSchema()._enum(ApiErrorCode.entries.map { it.name }))
            .addProperty("errors", ArraySchema().items(Schema<Any>().`$ref`("#/components/schemas/ApiFieldError")))
            .required(listOf("status", "detail", "code")) as ObjectSchema

    private fun problem(description: String): ApiResponse =
        ApiResponse().description(description).content(
            Content().addMediaType(
                "application/problem+json",
                MediaType().schema(Schema<Any>().`$ref`("#/components/schemas/ApiProblem")),
            ),
        )
}
