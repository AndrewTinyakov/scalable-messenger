package com.andrewtinyakov.messenger.chat.grpc.config

import io.grpc.Grpc
import io.grpc.Metadata
import io.grpc.ServerCall
import io.grpc.ServerCallHandler
import io.grpc.ServerInterceptor
import io.grpc.Status
import java.security.cert.CertificateParsingException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLPeerUnverifiedException

private const val URI_SUBJECT_ALTERNATIVE_NAME = 6

class GrpcClientIdentityInterceptor(
    private val allowedClientIdentity: String,
) : ServerInterceptor {
    init {
        require(allowedClientIdentity.isNotBlank()) { "Allowed gRPC client identity must be set" }
    }

    override fun <ReqT : Any, RespT : Any> interceptCall(
        call: ServerCall<ReqT, RespT>,
        headers: Metadata,
        next: ServerCallHandler<ReqT, RespT>,
    ): ServerCall.Listener<ReqT> {
        val session = call.attributes.get(Grpc.TRANSPORT_ATTR_SSL_SESSION)
        val certificate = try {
            session?.peerCertificates?.firstOrNull() as? X509Certificate
        } catch (_: SSLPeerUnverifiedException) {
            null
        }
        val authorized = try {
            certificate?.subjectAlternativeNames?.any { it[0] == URI_SUBJECT_ALTERNATIVE_NAME && it[1] == allowedClientIdentity } == true
        } catch (_: CertificateParsingException) {
            false
        }
        if (!authorized) {
            call.close(Status.PERMISSION_DENIED.withDescription("Unauthorized gRPC client identity"), Metadata())
            return object : ServerCall.Listener<ReqT>() {}
        }
        return next.startCall(call, headers)
    }
}
