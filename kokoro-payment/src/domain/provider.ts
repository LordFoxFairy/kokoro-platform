export type PaymentProviderKind = "stripe" | "alipay" | "wechat" | "mock";

// 支付 provider 配置：webhookSecretRef 是 env 变量名引用，密钥明文只存在运行环境，不落库。
export interface PaymentProviderConfig {
  id: string;
  key: string;
  kind: PaymentProviderKind;
  webhookSecretRef: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}
