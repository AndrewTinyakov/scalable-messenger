package com.andrewtinyakov.messenger.generated.grpc;

import static io.grpc.MethodDescriptor.generateFullMethodName;

/**
 */
@io.grpc.stub.annotations.GrpcGenerated
public final class ChatAuthorizationGrpc {

  private ChatAuthorizationGrpc() {}

  public static final java.lang.String SERVICE_NAME = "messenger.authorization.v1.ChatAuthorization";

  // Static method descriptors that strictly reflect the proto.
  private static volatile io.grpc.MethodDescriptor<com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest,
      com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse> getValidateSessionMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "ValidateSession",
      requestType = com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest.class,
      responseType = com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest,
      com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse> getValidateSessionMethod() {
    io.grpc.MethodDescriptor<com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest, com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse> getValidateSessionMethod;
    if ((getValidateSessionMethod = ChatAuthorizationGrpc.getValidateSessionMethod) == null) {
      synchronized (ChatAuthorizationGrpc.class) {
        if ((getValidateSessionMethod = ChatAuthorizationGrpc.getValidateSessionMethod) == null) {
          ChatAuthorizationGrpc.getValidateSessionMethod = getValidateSessionMethod =
              io.grpc.MethodDescriptor.<com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest, com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "ValidateSession"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ChatAuthorizationMethodDescriptorSupplier("ValidateSession"))
              .build();
        }
      }
    }
    return getValidateSessionMethod;
  }

  private static volatile io.grpc.MethodDescriptor<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest,
      com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse> getAuthorizeGroupMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "AuthorizeGroup",
      requestType = com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest.class,
      responseType = com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest,
      com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse> getAuthorizeGroupMethod() {
    io.grpc.MethodDescriptor<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest, com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse> getAuthorizeGroupMethod;
    if ((getAuthorizeGroupMethod = ChatAuthorizationGrpc.getAuthorizeGroupMethod) == null) {
      synchronized (ChatAuthorizationGrpc.class) {
        if ((getAuthorizeGroupMethod = ChatAuthorizationGrpc.getAuthorizeGroupMethod) == null) {
          ChatAuthorizationGrpc.getAuthorizeGroupMethod = getAuthorizeGroupMethod =
              io.grpc.MethodDescriptor.<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest, com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "AuthorizeGroup"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ChatAuthorizationMethodDescriptorSupplier("AuthorizeGroup"))
              .build();
        }
      }
    }
    return getAuthorizeGroupMethod;
  }

  private static volatile io.grpc.MethodDescriptor<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest,
      com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse> getAuthorizeGroupsMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "AuthorizeGroups",
      requestType = com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest.class,
      responseType = com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest,
      com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse> getAuthorizeGroupsMethod() {
    io.grpc.MethodDescriptor<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest, com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse> getAuthorizeGroupsMethod;
    if ((getAuthorizeGroupsMethod = ChatAuthorizationGrpc.getAuthorizeGroupsMethod) == null) {
      synchronized (ChatAuthorizationGrpc.class) {
        if ((getAuthorizeGroupsMethod = ChatAuthorizationGrpc.getAuthorizeGroupsMethod) == null) {
          ChatAuthorizationGrpc.getAuthorizeGroupsMethod = getAuthorizeGroupsMethod =
              io.grpc.MethodDescriptor.<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest, com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "AuthorizeGroups"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ChatAuthorizationMethodDescriptorSupplier("AuthorizeGroups"))
              .build();
        }
      }
    }
    return getAuthorizeGroupsMethod;
  }

  private static volatile io.grpc.MethodDescriptor<com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceRequest,
      com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceResponse> getAuthorizePresenceMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "AuthorizePresence",
      requestType = com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceRequest.class,
      responseType = com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceRequest,
      com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceResponse> getAuthorizePresenceMethod() {
    io.grpc.MethodDescriptor<com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceRequest, com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceResponse> getAuthorizePresenceMethod;
    if ((getAuthorizePresenceMethod = ChatAuthorizationGrpc.getAuthorizePresenceMethod) == null) {
      synchronized (ChatAuthorizationGrpc.class) {
        if ((getAuthorizePresenceMethod = ChatAuthorizationGrpc.getAuthorizePresenceMethod) == null) {
          ChatAuthorizationGrpc.getAuthorizePresenceMethod = getAuthorizePresenceMethod =
              io.grpc.MethodDescriptor.<com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceRequest, com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "AuthorizePresence"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ChatAuthorizationMethodDescriptorSupplier("AuthorizePresence"))
              .build();
        }
      }
    }
    return getAuthorizePresenceMethod;
  }

  /**
   * Creates a new async stub that supports all call types for the service
   */
  public static ChatAuthorizationStub newStub(io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<ChatAuthorizationStub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<ChatAuthorizationStub>() {
        @java.lang.Override
        public ChatAuthorizationStub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new ChatAuthorizationStub(channel, callOptions);
        }
      };
    return ChatAuthorizationStub.newStub(factory, channel);
  }

  /**
   * Creates a new blocking-style stub that supports all types of calls on the service
   */
  public static ChatAuthorizationBlockingV2Stub newBlockingV2Stub(
      io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<ChatAuthorizationBlockingV2Stub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<ChatAuthorizationBlockingV2Stub>() {
        @java.lang.Override
        public ChatAuthorizationBlockingV2Stub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new ChatAuthorizationBlockingV2Stub(channel, callOptions);
        }
      };
    return ChatAuthorizationBlockingV2Stub.newStub(factory, channel);
  }

  /**
   * Creates a new blocking-style stub that supports unary and streaming output calls on the service
   */
  public static ChatAuthorizationBlockingStub newBlockingStub(
      io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<ChatAuthorizationBlockingStub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<ChatAuthorizationBlockingStub>() {
        @java.lang.Override
        public ChatAuthorizationBlockingStub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new ChatAuthorizationBlockingStub(channel, callOptions);
        }
      };
    return ChatAuthorizationBlockingStub.newStub(factory, channel);
  }

  /**
   * Creates a new ListenableFuture-style stub that supports unary calls on the service
   */
  public static ChatAuthorizationFutureStub newFutureStub(
      io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<ChatAuthorizationFutureStub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<ChatAuthorizationFutureStub>() {
        @java.lang.Override
        public ChatAuthorizationFutureStub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new ChatAuthorizationFutureStub(channel, callOptions);
        }
      };
    return ChatAuthorizationFutureStub.newStub(factory, channel);
  }

  /**
   */
  public interface AsyncService {

    /**
     */
    default void validateSession(com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest request,
        io.grpc.stub.StreamObserver<com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getValidateSessionMethod(), responseObserver);
    }

    /**
     */
    default void authorizeGroup(com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest request,
        io.grpc.stub.StreamObserver<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getAuthorizeGroupMethod(), responseObserver);
    }

    /**
     */
    default void authorizeGroups(com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest request,
        io.grpc.stub.StreamObserver<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getAuthorizeGroupsMethod(), responseObserver);
    }

    /**
     */
    default void authorizePresence(com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceRequest request,
        io.grpc.stub.StreamObserver<com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getAuthorizePresenceMethod(), responseObserver);
    }
  }

  /**
   * Base class for the server implementation of the service ChatAuthorization.
   */
  public static abstract class ChatAuthorizationImplBase
      implements io.grpc.BindableService, AsyncService {

    @java.lang.Override public final io.grpc.ServerServiceDefinition bindService() {
      return ChatAuthorizationGrpc.bindService(this);
    }
  }

  /**
   * A stub to allow clients to do asynchronous rpc calls to service ChatAuthorization.
   */
  public static final class ChatAuthorizationStub
      extends io.grpc.stub.AbstractAsyncStub<ChatAuthorizationStub> {
    private ChatAuthorizationStub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected ChatAuthorizationStub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new ChatAuthorizationStub(channel, callOptions);
    }

    /**
     */
    public void validateSession(com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest request,
        io.grpc.stub.StreamObserver<com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getValidateSessionMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     */
    public void authorizeGroup(com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest request,
        io.grpc.stub.StreamObserver<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getAuthorizeGroupMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     */
    public void authorizeGroups(com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest request,
        io.grpc.stub.StreamObserver<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getAuthorizeGroupsMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     */
    public void authorizePresence(com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceRequest request,
        io.grpc.stub.StreamObserver<com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getAuthorizePresenceMethod(), getCallOptions()), request, responseObserver);
    }
  }

  /**
   * A stub to allow clients to do synchronous rpc calls to service ChatAuthorization.
   */
  public static final class ChatAuthorizationBlockingV2Stub
      extends io.grpc.stub.AbstractBlockingStub<ChatAuthorizationBlockingV2Stub> {
    private ChatAuthorizationBlockingV2Stub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected ChatAuthorizationBlockingV2Stub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new ChatAuthorizationBlockingV2Stub(channel, callOptions);
    }

    /**
     */
    public com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse validateSession(com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getValidateSessionMethod(), getCallOptions(), request);
    }

    /**
     */
    public com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse authorizeGroup(com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getAuthorizeGroupMethod(), getCallOptions(), request);
    }

    /**
     */
    public com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse authorizeGroups(com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getAuthorizeGroupsMethod(), getCallOptions(), request);
    }

    /**
     */
    public com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceResponse authorizePresence(com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getAuthorizePresenceMethod(), getCallOptions(), request);
    }
  }

  /**
   * A stub to allow clients to do limited synchronous rpc calls to service ChatAuthorization.
   */
  public static final class ChatAuthorizationBlockingStub
      extends io.grpc.stub.AbstractBlockingStub<ChatAuthorizationBlockingStub> {
    private ChatAuthorizationBlockingStub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected ChatAuthorizationBlockingStub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new ChatAuthorizationBlockingStub(channel, callOptions);
    }

    /**
     */
    public com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse validateSession(com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getValidateSessionMethod(), getCallOptions(), request);
    }

    /**
     */
    public com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse authorizeGroup(com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getAuthorizeGroupMethod(), getCallOptions(), request);
    }

    /**
     */
    public com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse authorizeGroups(com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getAuthorizeGroupsMethod(), getCallOptions(), request);
    }

    /**
     */
    public com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceResponse authorizePresence(com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getAuthorizePresenceMethod(), getCallOptions(), request);
    }
  }

  /**
   * A stub to allow clients to do ListenableFuture-style rpc calls to service ChatAuthorization.
   */
  public static final class ChatAuthorizationFutureStub
      extends io.grpc.stub.AbstractFutureStub<ChatAuthorizationFutureStub> {
    private ChatAuthorizationFutureStub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected ChatAuthorizationFutureStub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new ChatAuthorizationFutureStub(channel, callOptions);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse> validateSession(
        com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getValidateSessionMethod(), getCallOptions()), request);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse> authorizeGroup(
        com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getAuthorizeGroupMethod(), getCallOptions()), request);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse> authorizeGroups(
        com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getAuthorizeGroupsMethod(), getCallOptions()), request);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceResponse> authorizePresence(
        com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getAuthorizePresenceMethod(), getCallOptions()), request);
    }
  }

  private static final int METHODID_VALIDATE_SESSION = 0;
  private static final int METHODID_AUTHORIZE_GROUP = 1;
  private static final int METHODID_AUTHORIZE_GROUPS = 2;
  private static final int METHODID_AUTHORIZE_PRESENCE = 3;

  private static final class MethodHandlers<Req, Resp> implements
      io.grpc.stub.ServerCalls.UnaryMethod<Req, Resp>,
      io.grpc.stub.ServerCalls.ServerStreamingMethod<Req, Resp>,
      io.grpc.stub.ServerCalls.ClientStreamingMethod<Req, Resp>,
      io.grpc.stub.ServerCalls.BidiStreamingMethod<Req, Resp> {
    private final AsyncService serviceImpl;
    private final int methodId;

    MethodHandlers(AsyncService serviceImpl, int methodId) {
      this.serviceImpl = serviceImpl;
      this.methodId = methodId;
    }

    @java.lang.Override
    @java.lang.SuppressWarnings("unchecked")
    public void invoke(Req request, io.grpc.stub.StreamObserver<Resp> responseObserver) {
      switch (methodId) {
        case METHODID_VALIDATE_SESSION:
          serviceImpl.validateSession((com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest) request,
              (io.grpc.stub.StreamObserver<com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse>) responseObserver);
          break;
        case METHODID_AUTHORIZE_GROUP:
          serviceImpl.authorizeGroup((com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest) request,
              (io.grpc.stub.StreamObserver<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse>) responseObserver);
          break;
        case METHODID_AUTHORIZE_GROUPS:
          serviceImpl.authorizeGroups((com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest) request,
              (io.grpc.stub.StreamObserver<com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse>) responseObserver);
          break;
        case METHODID_AUTHORIZE_PRESENCE:
          serviceImpl.authorizePresence((com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceRequest) request,
              (io.grpc.stub.StreamObserver<com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceResponse>) responseObserver);
          break;
        default:
          throw new AssertionError();
      }
    }

    @java.lang.Override
    @java.lang.SuppressWarnings("unchecked")
    public io.grpc.stub.StreamObserver<Req> invoke(
        io.grpc.stub.StreamObserver<Resp> responseObserver) {
      switch (methodId) {
        default:
          throw new AssertionError();
      }
    }
  }

  public static final io.grpc.ServerServiceDefinition bindService(AsyncService service) {
    return io.grpc.ServerServiceDefinition.builder(getServiceDescriptor())
        .addMethod(
          getValidateSessionMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest,
              com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse>(
                service, METHODID_VALIDATE_SESSION)))
        .addMethod(
          getAuthorizeGroupMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest,
              com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse>(
                service, METHODID_AUTHORIZE_GROUP)))
        .addMethod(
          getAuthorizeGroupsMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest,
              com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse>(
                service, METHODID_AUTHORIZE_GROUPS)))
        .addMethod(
          getAuthorizePresenceMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceRequest,
              com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceResponse>(
                service, METHODID_AUTHORIZE_PRESENCE)))
        .build();
  }

  private static abstract class ChatAuthorizationBaseDescriptorSupplier
      implements io.grpc.protobuf.ProtoFileDescriptorSupplier, io.grpc.protobuf.ProtoServiceDescriptorSupplier {
    ChatAuthorizationBaseDescriptorSupplier() {}

    @java.lang.Override
    public com.google.protobuf.Descriptors.FileDescriptor getFileDescriptor() {
      return com.andrewtinyakov.messenger.generated.grpc.ChatAuthorizationOuterClass.getDescriptor();
    }

    @java.lang.Override
    public com.google.protobuf.Descriptors.ServiceDescriptor getServiceDescriptor() {
      return getFileDescriptor().findServiceByName("ChatAuthorization");
    }
  }

  private static final class ChatAuthorizationFileDescriptorSupplier
      extends ChatAuthorizationBaseDescriptorSupplier {
    ChatAuthorizationFileDescriptorSupplier() {}
  }

  private static final class ChatAuthorizationMethodDescriptorSupplier
      extends ChatAuthorizationBaseDescriptorSupplier
      implements io.grpc.protobuf.ProtoMethodDescriptorSupplier {
    private final java.lang.String methodName;

    ChatAuthorizationMethodDescriptorSupplier(java.lang.String methodName) {
      this.methodName = methodName;
    }

    @java.lang.Override
    public com.google.protobuf.Descriptors.MethodDescriptor getMethodDescriptor() {
      return getServiceDescriptor().findMethodByName(methodName);
    }
  }

  private static volatile io.grpc.ServiceDescriptor serviceDescriptor;

  public static io.grpc.ServiceDescriptor getServiceDescriptor() {
    io.grpc.ServiceDescriptor result = serviceDescriptor;
    if (result == null) {
      synchronized (ChatAuthorizationGrpc.class) {
        result = serviceDescriptor;
        if (result == null) {
          serviceDescriptor = result = io.grpc.ServiceDescriptor.newBuilder(SERVICE_NAME)
              .setSchemaDescriptor(new ChatAuthorizationFileDescriptorSupplier())
              .addMethod(getValidateSessionMethod())
              .addMethod(getAuthorizeGroupMethod())
              .addMethod(getAuthorizeGroupsMethod())
              .addMethod(getAuthorizePresenceMethod())
              .build();
        }
      }
    }
    return result;
  }
}
