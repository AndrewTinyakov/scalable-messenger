package com.andrewtinyakov.messenger.auth.config

import com.andrewtinyakov.messenger.auth.web.ApiSessionInterceptor
import com.andrewtinyakov.messenger.auth.web.AuthenticatedSessionArgumentResolver
import org.springframework.context.annotation.Configuration
import org.springframework.web.method.support.HandlerMethodArgumentResolver
import org.springframework.web.servlet.config.annotation.InterceptorRegistry
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer

@Configuration(proxyBeanMethods = false)
class ApiSessionConfiguration(
    private val interceptor: ApiSessionInterceptor,
    private val sessionArgument: AuthenticatedSessionArgumentResolver,
) : WebMvcConfigurer {
    override fun addArgumentResolvers(resolvers: MutableList<HandlerMethodArgumentResolver>) {
        resolvers.add(sessionArgument)
    }

    override fun addInterceptors(registry: InterceptorRegistry) {
        registry.addInterceptor(interceptor)
            .addPathPatterns("/**")
            .excludePathPatterns(
                "/v1/auth/register",
                "/v1/auth/login",
                "/v1/auth/logout",
                "/actuator/**",
                "/v3/api-docs/**",
                "/v3/api-docs.yaml",
                "/error",
            )
    }
}
