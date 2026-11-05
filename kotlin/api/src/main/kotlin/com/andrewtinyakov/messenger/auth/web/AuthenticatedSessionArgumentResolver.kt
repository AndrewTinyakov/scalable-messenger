package com.andrewtinyakov.messenger.auth.web

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import org.springframework.core.MethodParameter
import org.springframework.stereotype.Component
import org.springframework.web.bind.support.WebDataBinderFactory
import org.springframework.web.context.request.NativeWebRequest
import org.springframework.web.context.request.RequestAttributes
import org.springframework.web.method.support.HandlerMethodArgumentResolver
import org.springframework.web.method.support.ModelAndViewContainer

@Component
class AuthenticatedSessionArgumentResolver : HandlerMethodArgumentResolver {
    override fun supportsParameter(parameter: MethodParameter): Boolean = parameter.parameterType == AuthenticatedSession::class.java

    override fun resolveArgument(
        parameter: MethodParameter,
        mavContainer: ModelAndViewContainer?,
        webRequest: NativeWebRequest,
        binderFactory: WebDataBinderFactory?,
    ): AuthenticatedSession =
        checkNotNull(webRequest.getAttribute(AUTHENTICATED_SESSION_ATTRIBUTE, RequestAttributes.SCOPE_REQUEST) as AuthenticatedSession?) {
            "Authenticated session is missing"
        }
}
